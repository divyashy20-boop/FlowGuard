import { createHash, randomUUID } from "node:crypto";
import type { BackgroundJob, JobType, Prisma } from "@prisma/client";
import { prisma } from "./db";
import { localDocumentStorage } from "./document-storage";
import { malwareScanner } from "./malware-scanner";
import { processDocumentBytes } from "./document-processing-pipeline";
import { enqueueJobEvent } from "./job-service";
import { analyzeApplication } from "./compliance-intelligence";
import { matchApplication, similarity } from "./matching-intelligence";
import { localJsonIngestionAdapter, syntheticFixtureAdapter } from "./ingestion-adapters";
import { emailAdapter } from "./notification-adapters";
import { graphStore, GraphProjectionBusyError } from "./graph-store";

const workerId = `${process.pid}-${randomUUID()}`;
const leaseMs = 60_000;
const allowedJobTypes = new Set<JobType>(["PROCESS_DOCUMENT", "ANALYZE_COMPLIANCE", "MATCH_APPLICATION", "INGEST_FIXTURE", "INGEST_LOCAL"]);

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Processing failed";
  if (/unsupported document/i.test(message)) return "Unsupported document format.";
  if (/checksum/i.test(message)) return "Stored file integrity check failed.";
  if (/scanner/i.test(message)) return "Configured malware scanner failed. The document remains quarantined.";
  if (/not available in this tenant/i.test(message)) return "The requested record is no longer available.";
  return "Background processing failed. Retry is available; technical details were withheld.";
}

async function addNotification(tx: Prisma.TransactionClient, tenantId: string, userId: string | undefined, type: string, title: string, message: string, resourceType?: string, resourceId?: string, idempotencyKey?: string) {
  if (!userId) return null;
  if (idempotencyKey) return tx.notification.upsert({ where: { idempotencyKey }, update: {}, create: { tenantId, userId, type, title, message, resourceType, resourceId, idempotencyKey } });
  return tx.notification.create({ data: { tenantId, userId, type, title, message, resourceType, resourceId } });
}

async function dispatchOneOutboxEvent() {
  const staleBefore = new Date(Date.now() - leaseMs);
  return prisma.$transaction(async tx => {
    const event = await tx.outboxEvent.findFirst({ where: { eventType: "JOB_REQUESTED", processedAt: null, OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }] }, orderBy: { createdAt: "asc" } });
    if (!event) return false;
    const claimed = await tx.outboxEvent.updateMany({ where: { id: event.id, eventType: "JOB_REQUESTED", processedAt: null, OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }] }, data: { lockedAt: new Date(), lockOwner: workerId, attempts: { increment: 1 } } });
    if (!claimed.count) return false;
    const request = event.payload as Record<string, unknown>;
    const type = request.type;
    const tenantId = request.tenantId;
    const idempotencyKey = request.idempotencyKey;
    if (event.eventType !== "JOB_REQUESTED" || typeof type !== "string" || !allowedJobTypes.has(type as JobType) || typeof tenantId !== "string" || typeof idempotencyKey !== "string") {
      await tx.outboxEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), lastError: "Unsupported or invalid outbox event", lockedAt: null, lockOwner: null } });
      return true;
    }
    await tx.backgroundJob.upsert({
      where: { idempotencyKey },
      update: {},
      create: { tenantId, type: type as JobType, idempotencyKey, payload: (request.payload ?? {}) as Prisma.InputJsonValue }
    });
    await tx.outboxEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), lastError: null, lockedAt: null, lockOwner: null } });
    return true;
  });
}

async function dispatchOneGraphEvent() {
  if (!graphStore.isConfigured()) return false;
  const staleBefore = new Date(Date.now() - leaseMs);
  const event = await prisma.$transaction(async tx => {
    const candidate = await tx.outboxEvent.findFirst({ where: { eventType: "GRAPH_REFRESH_REQUESTED", processedAt: null, availableAt: { lte: new Date() }, OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }] }, orderBy: { createdAt: "asc" } });
    if (!candidate) return null;
    const claimed = await tx.outboxEvent.updateMany({ where: { id: candidate.id, eventType: "GRAPH_REFRESH_REQUESTED", processedAt: null, OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }] }, data: { lockedAt: new Date(), lockOwner: workerId, attempts: { increment: 1 } } });
    return claimed.count ? { ...candidate, attempts: candidate.attempts + 1 } : null;
  });
  if (!event) return false;

  try {
    await graphStore.rebuildTenant(event.aggregateId);
    await prisma.outboxEvent.updateMany({ where: { id: event.id, lockOwner: workerId, processedAt: null }, data: { processedAt: new Date(), lastError: null, lockedAt: null, lockOwner: null } });
  } catch (error) {
    if (error instanceof GraphProjectionBusyError) {
      await prisma.outboxEvent.updateMany({ where: { id: event.id, lockOwner: workerId, processedAt: null }, data: { attempts: { decrement: 1 }, availableAt: new Date(Date.now() + 5_000), lastError: null, lockedAt: null, lockOwner: null } });
      return true;
    }
    const dead = event.attempts >= 10;
    const retryDelay = Math.min(300_000, 1_000 * (2 ** Math.max(0, event.attempts - 1)));
    await prisma.outboxEvent.updateMany({ where: { id: event.id, lockOwner: workerId, processedAt: null }, data: { ...(dead ? { processedAt: new Date() } : { availableAt: new Date(Date.now() + retryDelay) }), lastError: dead ? "Graph projection failed after bounded retries." : "Graph projection failed; retry scheduled.", lockedAt: null, lockOwner: null } });
    await prisma.graphProjectionState.updateMany({ where: { tenantId: event.aggregateId }, data: { lastError: dead ? "Graph projection failed after bounded retries." : "Graph projection retry scheduled." } }).catch(() => undefined);
    console.error("Graph projection failed", { tenantId: event.aggregateId, attempt: event.attempts, errorName: error instanceof Error ? error.name : "UnknownError" });
  }
  return true;
}

async function processDocument(job: BackgroundJob) {
  const payload = job.payload as Record<string, unknown>;
  const documentId = String(payload.documentId ?? "");
  const document = await prisma.document.findFirst({ where: { id: documentId, application: { tenantId: job.tenantId } }, include: { application: { select: { id: true, institutionId: true } } } });
  if (!document) throw new Error("The requested record is no longer available.");
  await prisma.backgroundJob.update({ where: { id: job.id }, data: { progress: 10, progressMessage: "Validating private file and checksum." } });
  await prisma.document.update({ where: { id: document.id }, data: { processingState: "RUNNING", processingError: null, processingAttempts: { increment: 1 } } });
  const bytes = await localDocumentStorage.read(document.storageKey);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== document.checksumSha256) throw new Error("Stored file integrity check failed.");
  const scan = await malwareScanner.scan(bytes);
  if (scan.result === "INFECTED") {
    const notification = await prisma.$transaction(async tx => {
      await tx.document.update({ where: { id: document.id }, data: { status: "REJECTED", scanResult: "INFECTED", processingState: "FAILED", processingError: "Configured scanner reported an infected file.", processingWarnings: ["The file was rejected by the configured malware scanner."] } });
      await tx.auditEvent.create({ data: { tenantId: job.tenantId, actorUserId: typeof payload.requestedByUserId === "string" ? payload.requestedByUserId : null, action: "DOCUMENT_REJECTED_BY_SCANNER", resourceType: "Document", resourceId: document.id } });
      return addNotification(tx, job.tenantId, document.uploadedByUserId, "DOCUMENT_REJECTED", "Document rejected", "The configured scanner rejected a document. Contact a reviewer for next steps.", "Document", document.id);
    });
    if (notification) await emailAdapter.deliver({ notificationId: notification.id, type: notification.type });
    return;
  }
  if (scan.result === "ERROR") throw new Error("Configured malware scanner failed.");
  await prisma.backgroundJob.update({ where: { id: job.id }, data: { progress: 35, progressMessage: scan.result === "CLEAN" ? "Scanner reported clean; extracting text." : "No scanner is configured; extracting while the document remains quarantined." } });
  const extracted = await processDocumentBytes(bytes, document.mimeType);
  await prisma.backgroundJob.update({ where: { id: job.id }, data: { progress: 75, progressMessage: "Persisting extraction provenance and follow-up analysis." } });
  const notification = await prisma.$transaction(async tx => {
    await tx.evidenceExtraction.createMany({ data: extracted.fields.map((field, fieldOrdinal) => ({ documentId: document.id, fieldName: field.fieldName, extractedValue: field.extractedValue, confidence: field.confidence, confidenceBasis: field.confidenceBasis, sourceText: field.sourceText, pageNumber: field.pageNumber, extractor: field.extractor, extractorVersion: field.extractorVersion, sourceRunId: job.id, fieldOrdinal })), skipDuplicates: true });
    await tx.document.update({ where: { id: document.id }, data: { status: scan.result === "CLEAN" ? "AVAILABLE" : "QUARANTINED", scanResult: scan.result, processingState: "SUCCEEDED", processingError: null, processingWarnings: extracted.warnings as Prisma.InputJsonValue } });
    if (!await tx.auditEvent.findFirst({ where: { tenantId: job.tenantId, action: "DOCUMENT_PROCESSING_COMPLETED", resourceType: "Document", resourceId: document.id, metadata: { path: ["jobId"], equals: job.id } } })) await tx.auditEvent.create({ data: { tenantId: job.tenantId, actorUserId: typeof payload.requestedByUserId === "string" ? payload.requestedByUserId : null, action: "DOCUMENT_PROCESSING_COMPLETED", resourceType: "Document", resourceId: document.id, metadata: { jobId: job.id, processingMode: extracted.processingMode, extractedFieldCount: extracted.fields.length, scanResult: scan.result, scannerAdapter: scan.adapter } } });
    await enqueueJobEvent(tx, { tenantId: job.tenantId, type: "ANALYZE_COMPLIANCE", aggregateType: "Application", aggregateId: document.applicationId, payload: { applicationId: document.applicationId, requestedByUserId: document.uploadedByUserId }, idempotencyKey: `analysis:${job.id}` });
    await enqueueJobEvent(tx, { tenantId: job.tenantId, type: "MATCH_APPLICATION", aggregateType: "Application", aggregateId: document.applicationId, payload: { applicationId: document.applicationId, requestedByUserId: document.uploadedByUserId }, idempotencyKey: `match:${job.id}` });
    return addNotification(tx, job.tenantId, document.uploadedByUserId, "DOCUMENT_PROCESSED", "Document processing finished", scan.result === "CLEAN" ? "Text extraction finished and the configured scanner reported clean." : "Text extraction finished. The file remains quarantined because no malware scanner confirmed it clean.", "Document", document.id, `document-processed:${job.id}`);
  });
  if (notification) await emailAdapter.deliver({ notificationId: notification.id, type: notification.type });
}

async function processFixture(job: BackgroundJob) {
  const payload = job.payload as Record<string, unknown>;
  const batchId = String(payload.batchId ?? "");
  const batch = await prisma.ingestionBatch.findFirst({ where: { id: batchId, tenantId: job.tenantId } });
  if (!batch) throw new Error("The requested record is no longer available.");
  await prisma.ingestionBatch.update({ where: { id: batch.id }, data: { status: "RUNNING", startedAt: batch.startedAt ?? new Date() } });
  await prisma.backgroundJob.update({ where: { id: job.id }, data: { progress: 25, progressMessage: "Loading the bundled synthetic fixture." } });
  const records = await syntheticFixtureAdapter.read();
  const institutions = await prisma.institution.findMany({ where: { tenantId: job.tenantId, archivedAt: null }, select: { id: true, name: true } });
  for (const record of records) {
    const candidate = institutions.map(institution => ({ institution, score: similarity(institution.name, record.name) })).sort((a, b) => b.score - a.score)[0];
    const candidateInstitutionId = candidate && candidate.score >= 0.55 ? candidate.institution.id : null;
    await prisma.ingestionRecord.upsert({
      where: { batchId_sourceRecordKey: { batchId: batch.id, sourceRecordKey: record.sourceRecordKey } },
      create: { batchId: batch.id, sourceRecordKey: record.sourceRecordKey, normalizedData: record as Prisma.InputJsonValue, status: "NEEDS_REVIEW", candidateInstitutionId, candidateScore: candidateInstitutionId ? candidate!.score : null, matchReasons: candidateInstitutionId ? [{ field: "institution_name", signal: "normalized_edit_similarity", score: Number(candidate!.score.toFixed(3)), candidateInstitutionId }] as Prisma.InputJsonValue : [] },
      update: {}
    });
  }
  const stagedRecords = await prisma.ingestionRecord.count({ where: { batchId: batch.id } });
  await prisma.backgroundJob.update({ where: { id: job.id }, data: { progress: 75, progressMessage: "Staging records for human reconciliation." } });
  const notification = await prisma.$transaction(async tx => {
    await tx.ingestionBatch.update({ where: { id: batch.id }, data: { status: "COMPLETED", sourceChecksum: createHash("sha256").update(JSON.stringify(records)).digest("hex"), totalRecords: records.length, stagedRecords, completedAt: new Date(), errorSummary: null } });
    await tx.auditEvent.create({ data: { tenantId: job.tenantId, actorUserId: batch.createdByUserId, action: "SYNTHETIC_IMPORT_COMPLETED", resourceType: "IngestionBatch", resourceId: batch.id, metadata: { totalRecords: records.length, stagedRecords } } });
    const notification = await addNotification(tx, job.tenantId, batch.createdByUserId, "IMPORT_COMPLETED", "Synthetic import ready for review", `${stagedRecords} fictional fixture records are staged. Review each record before linking or creating an institution.`, "IngestionBatch", batch.id, `import-complete:${batch.id}`);
    return notification;
  });
  if (notification) await emailAdapter.deliver({ notificationId: notification.id, type: notification.type });
}

async function processLocalImport(job: BackgroundJob) {
  const payload = job.payload as Record<string, unknown>;
  const batchId = String(payload.batchId ?? "");
  const batch = await prisma.ingestionBatch.findFirst({ where: { id: batchId, tenantId: job.tenantId } });
  if (!batch) throw new Error("The requested record is no longer available.");
  await prisma.ingestionBatch.update({ where: { id: batch.id }, data: { status: "RUNNING", startedAt: batch.startedAt ?? new Date() } });
  const rows = await prisma.ingestionRecord.findMany({ where: { batchId: batch.id }, orderBy: { sourceRecordKey: "asc" } });
  const records = localJsonIngestionAdapter.parse(rows.map(row => row.normalizedData));
  const institutions = await prisma.institution.findMany({ where: { tenantId: job.tenantId, archivedAt: null }, select: { id: true, name: true } });
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const record = records[index];
    const candidate = institutions.map(institution => ({ institution, score: similarity(institution.name, record.name) })).sort((a, b) => b.score - a.score)[0];
    const candidateInstitutionId = candidate && candidate.score >= 0.55 ? candidate.institution.id : null;
    await prisma.ingestionRecord.updateMany({ where: { id: row.id, status: "NEEDS_REVIEW" }, data: { candidateInstitutionId, candidateScore: candidateInstitutionId ? candidate!.score : null, matchReasons: candidateInstitutionId ? [{ field: "institution_name", signal: "normalized_edit_similarity", score: Number(candidate!.score.toFixed(3)), candidateInstitutionId }] : [] } });
    if (index % 25 === 0) await prisma.backgroundJob.update({ where: { id: job.id }, data: { progress: Math.min(85, Math.round((index + 1) / Math.max(1, rows.length) * 85)), progressMessage: `Reconciliation suggestions prepared for ${index + 1} of ${rows.length} records.` } });
  }
  const stagedRecords = await prisma.ingestionRecord.count({ where: { batchId: batch.id } });
  await prisma.$transaction(async tx => {
    await tx.ingestionBatch.update({ where: { id: batch.id }, data: { status: "COMPLETED", stagedRecords, completedAt: new Date(), errorSummary: null } });
    await tx.auditEvent.create({ data: { tenantId: job.tenantId, actorUserId: batch.createdByUserId, action: "AUTHORIZED_LOCAL_IMPORT_COMPLETED", resourceType: "IngestionBatch", resourceId: batch.id, metadata: { totalRecords: rows.length, stagedRecords, sourceChecksum: batch.sourceChecksum } } });
    return addNotification(tx, job.tenantId, batch.createdByUserId, "IMPORT_COMPLETED", "Local import ready for review", `${stagedRecords} validated records are staged. Review each record before linking or creating an institution.`, "IngestionBatch", batch.id, `import-complete:${batch.id}`);
  }).then(async notification => { if (notification) await emailAdapter.deliver({ notificationId: notification.id, type: notification.type }); });
}

async function runJob(job: BackgroundJob) {
  const payload = job.payload as Record<string, unknown>;
  switch (job.type) {
    case "PROCESS_DOCUMENT": return processDocument(job);
    case "ANALYZE_COMPLIANCE": {
      const applicationId = String(payload.applicationId ?? "");
      const result = await analyzeApplication(job.tenantId, applicationId);
      if (result.newFindingCount > 0 && typeof payload.requestedByUserId === "string") {
        const key = `analysis-findings:${applicationId}:${result.findingSignature}`;
        const notification = await prisma.notification.upsert({ where: { idempotencyKey: key }, update: {}, create: { tenantId: job.tenantId, userId: payload.requestedByUserId, type: "COMPLIANCE_FINDINGS", title: "New compliance review findings", message: `${result.newFindingCount} new explainable findings are available for application ${applicationId}. Review the cited evidence before taking action.`, resourceType: "Application", resourceId: applicationId, idempotencyKey: key } });
        await emailAdapter.deliver({ notificationId: notification.id, type: notification.type });
      }
      return result;
    }
    case "MATCH_APPLICATION": {
      const applicationId = String(payload.applicationId ?? "");
      const result = await matchApplication(job.tenantId, applicationId);
      if (result.candidateCount > 0 && typeof payload.requestedByUserId === "string") {
        const key = `match-candidates:${applicationId}:${result.candidateSignature}`;
        const notification = await prisma.notification.upsert({ where: { idempotencyKey: key }, update: {}, create: { tenantId: job.tenantId, userId: payload.requestedByUserId, type: "MATCH_CANDIDATES", title: "Potential record matches ready", message: `${result.candidateCount} potential application match(es) are available for human review. No records were merged.`, resourceType: "Application", resourceId: applicationId, idempotencyKey: key } });
        await emailAdapter.deliver({ notificationId: notification.id, type: notification.type });
      }
      return result;
    }
    case "INGEST_FIXTURE": return processFixture(job);
    case "INGEST_LOCAL": return processLocalImport(job);
  }
}

async function claimJob() {
  const now = new Date();
  const staleBefore = new Date(Date.now() - leaseMs);
  const stale = await prisma.backgroundJob.findMany({ where: { status: "RUNNING", lockedAt: { lt: staleBefore } }, select: { id: true, tenantId: true, type: true, payload: true, attempts: true, maxAttempts: true }, take: 20 });
  for (const job of stale) {
    const dead = job.attempts >= job.maxAttempts;
    const recovered = await prisma.backgroundJob.updateMany({ where: { id: job.id, status: "RUNNING", lockedAt: { lt: staleBefore } }, data: { status: dead ? "DEAD_LETTER" : "RETRY", lockedAt: null, lockOwner: null, availableAt: now, lastError: "Worker lease expired; job made available for recovery.", progressMessage: dead ? "Dead-lettered after worker lease expiry." : "Worker lease expired; retry queued." } });
    if (recovered.count && dead) {
      const payload = job.payload as Record<string, unknown>;
      if (typeof payload.requestedByUserId === "string") {
        const idempotencyKey = `stale-dead-letter:${job.id}`;
        const notification = await prisma.notification.upsert({ where: { idempotencyKey }, update: {}, create: { tenantId: job.tenantId, userId: payload.requestedByUserId, type: "JOB_DEAD_LETTER", title: "Background work needs attention", message: "A background task exhausted its retry allowance after a worker interruption.", resourceType: "BackgroundJob", resourceId: job.id, idempotencyKey } });
        await emailAdapter.deliver({ notificationId: notification.id, type: notification.type });
      }
    }
  }
  const candidate = await prisma.backgroundJob.findFirst({ where: { status: { in: ["PENDING", "RETRY"] }, availableAt: { lte: now } }, orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }] });
  if (!candidate) return null;
  const claimed = await prisma.backgroundJob.updateMany({ where: { id: candidate.id, status: { in: ["PENDING", "RETRY"] }, availableAt: { lte: now } }, data: { status: "RUNNING", attempts: { increment: 1 }, lockedAt: now, lockOwner: workerId, startedAt: candidate.startedAt ?? now, progressMessage: "Worker claimed job." } });
  return claimed.count ? prisma.backgroundJob.findUnique({ where: { id: candidate.id } }) : null;
}

export async function runWorkerOnce() {
  const projected = await dispatchOneGraphEvent();
  const dispatched = await dispatchOneOutboxEvent();
  const job = await claimJob();
  if (!job) return projected || dispatched;
  try {
    await runJob(job);
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: "COMPLETED", progress: 100, progressMessage: "Completed.", completedAt: new Date(), lockedAt: null, lockOwner: null, lastError: null } });
  } catch (error) {
    const dead = job.attempts >= job.maxAttempts;
    const retryDelay = Math.min(300_000, 1_000 * (2 ** Math.max(0, job.attempts - 1)));
    const message = safeError(error);
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: dead ? "DEAD_LETTER" : "RETRY", availableAt: new Date(Date.now() + retryDelay), lockedAt: null, lockOwner: null, lastError: message, progressMessage: dead ? "Dead-lettered after bounded retries." : "Retry scheduled with backoff.", ...(dead ? { completedAt: new Date() } : {}) } });
    if (job.type === "PROCESS_DOCUMENT") {
      const payload = job.payload as Record<string, unknown>;
      const documentId = String(payload.documentId ?? "");
      const scannerFailed = error instanceof Error && /scanner/i.test(error.message);
      await prisma.document.updateMany({ where: { id: documentId, application: { tenantId: job.tenantId } }, data: { processingState: dead ? "FAILED" : "QUEUED", processingError: message, ...(scannerFailed ? { scanResult: "ERROR" } : {}) } });
    }
    if (dead) {
      const payload = job.payload as Record<string, unknown>;
      const userId = typeof payload.requestedByUserId === "string" ? payload.requestedByUserId : null;
      if (job.type === "INGEST_FIXTURE") await prisma.ingestionBatch.updateMany({ where: { id: String(payload.batchId ?? ""), tenantId: job.tenantId }, data: { status: "FAILED", errorSummary: message, completedAt: new Date() } });
      if (job.type === "INGEST_LOCAL") await prisma.ingestionBatch.updateMany({ where: { id: String(payload.batchId ?? ""), tenantId: job.tenantId }, data: { status: "FAILED", errorSummary: message, completedAt: new Date() } });
      if (userId) {
        const notification = await prisma.notification.create({ data: { tenantId: job.tenantId, userId, type: "JOB_DEAD_LETTER", title: "Background work needs attention", message, resourceType: "BackgroundJob", resourceId: job.id } });
        await emailAdapter.deliver({ notificationId: notification.id, type: notification.type });
      }
    }
  }
  return true;
}
