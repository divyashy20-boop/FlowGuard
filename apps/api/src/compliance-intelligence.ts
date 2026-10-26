import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";

const RULE_VERSION = "flowguard-compliance-v1";
type Ref = Record<string, unknown>;
type Draft = { key: string; code: string; severity: "INFO" | "WARNING" | "HIGH"; title: string; explanation: string; requirementId?: string; refs: Ref[] };

function normalize(value: unknown) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseDate(value: unknown): Date | null {
  const text = String(value ?? "").trim();
  const dayFirst = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  const parsed = dayFirst
    ? new Date(Number(dayFirst[3].length === 2 ? `20${dayFirst[3]}` : dayFirst[3]), Number(dayFirst[2]) - 1, Number(dayFirst[1]))
    : new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dedupe(appId: string, code: string, scope: string) {
  return createHash("sha256").update(`${appId}|${code}|${scope}`).digest("hex");
}

export async function analyzeApplication(tenantId: string, applicationId: string) {
  const application = await prisma.application.findFirst({
    where: { id: applicationId, tenantId },
    include: {
      institution: { include: { promoter: true } },
      documents: { include: { extractions: true } },
      workflow: { include: { requirements: { include: { evidence: { include: { document: { include: { extractions: true } } } } } } }
    }
  });
  if (!application) throw new Error("Application is not available in this tenant.");

  const drafts: Draft[] = [];
  const requiredByRequirement = (application.workflow?.config as Record<string, unknown> | undefined)?.requiredFieldsByRequirement as Record<string, string[]> | undefined;
  const expiryFields = ((application.workflow?.config as Record<string, unknown> | undefined)?.expiryFields as unknown[] | undefined)?.filter((v): v is string => typeof v === "string") ?? [];
  const evidenceForRequirement = new Map<string, any[]>();
  const allExtractions: Array<{ extraction: any; document: any }> = [];

  for (const requirement of application.workflow?.requirements ?? []) {
    const linkedDocuments = requirement.evidence.map(link => link.document);
    evidenceForRequirement.set(requirement.id, linkedDocuments.map(document => ({ document })));
    if (requirement.mandatory && linkedDocuments.length === 0) {
      drafts.push({ key: requirement.id, code: "MISSING_MANDATORY_EVIDENCE", severity: "HIGH", title: `Missing evidence for ${requirement.code}`, explanation: `No document is linked to mandatory requirement ${requirement.code}. Missing evidence is not treated as proof of non-compliance.`, requirementId: requirement.id, refs: [{ requirementId: requirement.id, requirementCode: requirement.code, workflowVersion: application.workflow?.version }] });
    }
    for (const document of linkedDocuments) {
      if (document.processingState === "QUEUED" || document.processingState === "RUNNING") drafts.push({ key: `${requirement.id}:${document.id}`, code: "EVIDENCE_PROCESSING", severity: "INFO", title: `Evidence processing for ${requirement.code}`, explanation: "A linked document is waiting for background processing or is currently being processed.", requirementId: requirement.id, refs: [{ requirementId: requirement.id, documentId: document.id, version: document.version }] });
      if (document.processingState === "FAILED") drafts.push({ key: `${requirement.id}:${document.id}`, code: "EVIDENCE_PROCESSING_FAILED", severity: "WARNING", title: `Evidence processing failed for ${requirement.code}`, explanation: "A linked document could not be processed. Retry processing or review the original file.", requirementId: requirement.id, refs: [{ requirementId: requirement.id, documentId: document.id, version: document.version }] });
      if (document.scanResult !== "CLEAN") drafts.push({ key: `${requirement.id}:${document.id}`, code: "DOCUMENT_SCAN_UNAVAILABLE", severity: "WARNING", title: "Document remains quarantined", explanation: "No configured malware scanner has confirmed this file as clean. Text extraction does not constitute a malware scan or authenticity verification.", requirementId: requirement.id, refs: [{ requirementId: requirement.id, documentId: document.id, version: document.version, scanResult: document.scanResult }] });
      if (document.processingState === "SUCCEEDED" && document.extractions.length === 0) drafts.push({ key: `${requirement.id}:${document.id}`, code: "NO_RELEVANT_EXTRACTED_FIELDS", severity: "INFO", title: `No structured fields found for ${requirement.code}`, explanation: "The file was processed but the configured rule extractor found no supported fields. Review the document manually.", requirementId: requirement.id, refs: [{ requirementId: requirement.id, documentId: document.id, version: document.version }] });
      if (document.extractions.some(item => !item.humanVerified)) drafts.push({ key: `${requirement.id}:${document.id}`, code: "EXTRACTION_REVIEW_PENDING", severity: "WARNING", title: `Human review required for ${requirement.code}`, explanation: "One or more extracted suggestions are awaiting human verification. OCR and rule output are not verified facts.", requirementId: requirement.id, refs: document.extractions.filter(item => !item.humanVerified).map(item => ({ requirementId: requirement.id, documentId: document.id, version: document.version, extractionId: item.id, fieldName: item.fieldName, pageNumber: item.pageNumber, sourceText: item.sourceText })) });
    }
    const requiredFields = Array.isArray(requiredByRequirement?.[requirement.code]) ? requiredByRequirement[requirement.code] : [];
    const extracted = linkedDocuments.flatMap(document => document.extractions);
    const missing = requiredFields.filter(field => !extracted.some(item => item.fieldName === field && item.humanVerified && item.verifiedValue !== null));
    if (linkedDocuments.length && missing.length) drafts.push({ key: requirement.id, code: "MISSING_REQUIRED_FIELD", severity: "WARNING", title: `Required fields need verification for ${requirement.code}`, explanation: `Configured required fields are missing or not human-verified: ${missing.join(", ")}.`, requirementId: requirement.id, refs: linkedDocuments.flatMap(document => document.extractions.map(item => ({ requirementId: requirement.id, documentId: document.id, version: document.version, extractionId: item.id, fieldName: item.fieldName, pageNumber: item.pageNumber, sourceText: item.sourceText }))) });
  }

  for (const document of application.documents) for (const extraction of document.extractions) allExtractions.push({ extraction, document });

  for (const { extraction, document } of allExtractions) {
    if (!extraction.humanVerified) continue;
    if (expiryFields.includes(extraction.fieldName)) {
      const parsed = parseDate(extraction.verifiedValue ?? extraction.extractedValue);
      if (parsed && parsed.getTime() < Date.now()) drafts.push({ key: `${document.id}:${extraction.id}`, code: "VERIFIED_DATE_EXPIRED", severity: "HIGH", title: "Verified source date is in the past", explanation: `The configured expiry field ${extraction.fieldName} contains a verified date that has passed. Confirm the applicable rule and source context.`, refs: [{ documentId: document.id, version: document.version, extractionId: extraction.id, fieldName: extraction.fieldName, pageNumber: extraction.pageNumber, sourceText: extraction.sourceText, configuredRule: extraction.fieldName }] });
    }
  }

  for (const { extraction, document } of allExtractions) {
    if (extraction.humanVerified || !expiryFields.includes(extraction.fieldName)) continue;
    const parsed = parseDate(extraction.extractedValue);
    if (parsed && parsed.getTime() < Date.now()) drafts.push({ key: `${document.id}:${extraction.id}`, code: "POTENTIAL_EXPIRY_UNVERIFIED", severity: "INFO", title: "Unverified date may have passed", explanation: "An extracted date covered by a configured expiry rule appears to be in the past, but a reviewer has not verified the value.", refs: [{ documentId: document.id, version: document.version, extractionId: extraction.id, fieldName: extraction.fieldName, pageNumber: extraction.pageNumber, sourceText: extraction.sourceText, humanVerified: false }] });
  }

  const grouped = new Map<string, typeof allExtractions>();
  for (const record of allExtractions) {
    const key = record.extraction.fieldName;
    const list = grouped.get(key) ?? [];
    list.push(record);
    grouped.set(key, list);
  }
  for (const [fieldName, records] of grouped) {
    const values = new Map<string, typeof records>();
    for (const record of records) {
      const value = normalize(record.extraction.verifiedValue ?? record.extraction.extractedValue);
      if (!value) continue;
      const list = values.get(value) ?? [];
      list.push(record);
      values.set(value, list);
    }
    if (values.size > 1) drafts.push({ key: fieldName, code: "CONFLICTING_FIELD_VALUES", severity: "WARNING", title: `Different values found for ${fieldName}`, explanation: "Documents contain different extracted values for this field. Compare each value with its cited page and source text before resolving the conflict.", refs: records.map(({ extraction, document }) => ({ documentId: document.id, version: document.version, extractionId: extraction.id, fieldName, value: extraction.verifiedValue ?? extraction.extractedValue, humanVerified: extraction.humanVerified, pageNumber: extraction.pageNumber, sourceText: extraction.sourceText })) });
  }

  for (const { extraction, document } of allExtractions.filter(item => item.extraction.humanVerified)) {
    if (extraction.fieldName === "institution_name" && normalize(extraction.verifiedValue ?? extraction.extractedValue) !== normalize(application.institution.name)) drafts.push({ key: `${document.id}:${extraction.id}`, code: "INSTITUTION_NAME_DIFFERS", severity: "WARNING", title: "Document institution name differs", explanation: "A human-verified document value differs from the institution registry name. This is a review flag, not a finding that the records refer to different institutions.", refs: [{ institutionId: application.institutionId, documentId: document.id, version: document.version, extractionId: extraction.id, fieldName: extraction.fieldName, sourceText: extraction.sourceText }] });
    if (extraction.fieldName === "promoter_name" && application.institution.promoter && normalize(extraction.verifiedValue ?? extraction.extractedValue) !== normalize(application.institution.promoter.name)) drafts.push({ key: `${document.id}:${extraction.id}`, code: "PROMOTER_NAME_DIFFERS", severity: "WARNING", title: "Document promoter name differs", explanation: "A human-verified document value differs from the linked promoter name. Review the cited source; names alone do not establish identity.", refs: [{ promoterId: application.institution.promoter.id, documentId: document.id, version: document.version, extractionId: extraction.id, fieldName: extraction.fieldName, sourceText: extraction.sourceText }] });
  }

  if (application.workflow) {
    const previous = await prisma.workflowDefinition.findFirst({ where: { category: application.workflow.category, version: { lt: application.workflow.version } }, orderBy: { version: "desc" }, include: { requirements: { select: { code: true } } } });
    if (previous) {
      const previousCodes = new Set(previous.requirements.map(item => item.code));
      const added = application.workflow.requirements.filter(item => !previousCodes.has(item.code));
      const currentCodes = new Set(application.workflow.requirements.map(item => item.code));
      const removed = previous.requirements.filter(item => !currentCodes.has(item.code));
      for (const requirement of added) drafts.push({ key: requirement.code, code: "WORKFLOW_REQUIREMENT_ADDED", severity: "INFO", title: `Requirement added in workflow v${application.workflow.version}`, explanation: `${requirement.code} is present in the assigned workflow version but not in the previous version. This is version context, not a retroactive compliance decision.`, requirementId: requirement.id, refs: [{ workflowId: application.workflow.id, currentVersion: application.workflow.version, previousWorkflowId: previous.id, previousVersion: previous.version, requirementCode: requirement.code }] });
      for (const requirement of removed) drafts.push({ key: requirement.code, code: "WORKFLOW_REQUIREMENT_REMOVED", severity: "INFO", title: `Requirement removed in workflow v${application.workflow.version}`, explanation: `${requirement.code} was present in the previous workflow version and is absent from the assigned version. This is version context, not a retroactive compliance decision.`, refs: [{ workflowId: application.workflow.id, currentVersion: application.workflow.version, previousWorkflowId: previous.id, previousVersion: previous.version, requirementCode: requirement.code }] });
    }
  }

  const now = new Date();
  const keys = drafts.map(draft => dedupe(application.id, draft.code, draft.key));
  const newFindingCount = await prisma.$transaction(async tx => {
    const existingCount = keys.length ? await tx.complianceFinding.count({ where: { dedupeKey: { in: keys } } }) : 0;
    for (const draft of drafts) {
      const dedupeKey = dedupe(application.id, draft.code, draft.key);
      const previousFinding = await tx.complianceFinding.findUnique({ where: { dedupeKey }, select: { status: true } });
      await tx.complianceFinding.upsert({
        where: { dedupeKey },
        create: { tenantId, applicationId, requirementId: draft.requirementId, dedupeKey, code: draft.code, severity: draft.severity, title: draft.title, explanation: draft.explanation, evidenceReferences: draft.refs as Prisma.InputJsonValue, ruleVersion: RULE_VERSION, lastRefreshedAt: now },
        update: { requirementId: draft.requirementId, severity: draft.severity, title: draft.title, explanation: draft.explanation, evidenceReferences: draft.refs as Prisma.InputJsonValue, ruleVersion: RULE_VERSION, lastRefreshedAt: now, ...(previousFinding?.status === "RESOLVED" ? { status: "OPEN", resolutionNotes: null, resolvedByUserId: null } : {}) }
      });
    }
    await tx.complianceFinding.updateMany({ where: { tenantId, applicationId, status: { in: ["OPEN", "ACKNOWLEDGED"] }, ...(keys.length ? { dedupeKey: { notIn: keys } } : {}) }, data: { status: "RESOLVED", resolutionNotes: "Rule no longer matches during refresh.", lastRefreshedAt: now } });
    const mandatory = application.workflow?.requirements.filter(item => item.mandatory) ?? [];
    const satisfied = mandatory.filter(requirement => {
      const docs = evidenceForRequirement.get(requirement.id) ?? [];
      const requiredFields = Array.isArray(requiredByRequirement?.[requirement.code]) ? requiredByRequirement[requirement.code] : [];
      return docs.some(({ document }) => document.processingState === "SUCCEEDED" && (requiredFields.length ? requiredFields.every(field => document.extractions.some((item: any) => item.fieldName === field && item.humanVerified && item.verifiedValue !== null)) : document.extractions.some((item: any) => item.humanVerified)));
    }).length;
    const estimate = mandatory.length ? Math.round((satisfied / mandatory.length) * 100) : 100;
    const summary = { mandatoryRequirements: mandatory.length, evidenceReviewed: satisfied, findingCount: drafts.length, ruleVersion: RULE_VERSION, estimateMeaning: "Readiness estimate based on configured evidence and review rules; not an official AICTE score, approval prediction, or compliance certification." };
    await tx.complianceAnalysis.upsert({ where: { applicationId }, create: { tenantId, applicationId, readinessEstimate: estimate, ruleVersion: RULE_VERSION, summary: summary as Prisma.InputJsonValue, computedAt: now }, update: { tenantId, readinessEstimate: estimate, ruleVersion: RULE_VERSION, summary: summary as Prisma.InputJsonValue, computedAt: now } });
    return Math.max(0, drafts.length - existingCount);
  });
  return { findingCount: drafts.length, newFindingCount, findingSignature: createHash("sha256").update(keys.slice().sort().join("|")).digest("hex"), ruleVersion: RULE_VERSION };
}
