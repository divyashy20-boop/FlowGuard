import type { Express } from "express";
import { z } from "zod";
import { prisma } from "./db";
import { enqueueJobEvent } from "./job-service";
import { requireAuth, requireRole } from "./security";
import { createHash } from "node:crypto";
import { localJsonIngestionAdapter } from "./ingestion-adapters";

const reviewSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("LINK_EXISTING"), institutionId: z.string().min(1), notes: z.string().trim().max(2000).optional() }),
  z.object({ action: z.literal("CREATE_NEW"), notes: z.string().trim().max(2000).optional() }),
  z.object({ action: z.literal("IGNORE"), notes: z.string().trim().max(2000).optional() })
]);

export function registerIngestionRoutes(app: Express) {
  app.get("/ingestion/batches", requireAuth, async (req, res, next) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
      const status = typeof req.query.status === "string" && ["QUEUED", "RUNNING", "COMPLETED", "FAILED"].includes(req.query.status) ? req.query.status as "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" : undefined;
      const items = await prisma.ingestionBatch.findMany({ where: { tenantId: req.authUser!.tenantId, ...(status ? { status } : {}), ...(q ? { OR: [{ sourceName: { contains: q, mode: "insensitive" } }, { sourceType: { contains: q, mode: "insensitive" } }] } : {}) }, include: { _count: { select: { records: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
      return res.json({ items });
    } catch (error) { return next(error); }
  });
  app.get("/ingestion/batches/:id", requireAuth, async (req, res, next) => {
    try {
      const item = await prisma.ingestionBatch.findFirst({ where: { id: req.params.id, tenantId: req.authUser!.tenantId }, include: { records: { orderBy: { sourceRecordKey: "asc" } } } });
      return item ? res.json(item) : res.status(404).json({ error: "Import batch not found" });
    } catch (error) { return next(error); }
  });
  app.post("/ingestion/fixtures", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const auth = req.authUser!;
      const header = req.header("Idempotency-Key");
      if (header && (header.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(header))) return res.status(400).json({ error: "Invalid Idempotency-Key header" });
      const idempotencyKey = `fixture:${auth.tenantId}:${header || `${auth.userId}:${Date.now()}`}`;
      const batch = await prisma.$transaction(async tx => {
        const created = await tx.ingestionBatch.upsert({ where: { idempotencyKey }, update: {}, create: { tenantId: auth.tenantId, createdByUserId: auth.userId, sourceName: "Synthetic local fixture", sourceType: "SYNTHETIC_LOCAL_FIXTURE", sourceReference: "Bundled fictional sample records", idempotencyKey } });
        await enqueueJobEvent(tx, { tenantId: auth.tenantId, type: "INGEST_FIXTURE", aggregateType: "IngestionBatch", aggregateId: created.id, payload: { batchId: created.id, requestedByUserId: auth.userId }, idempotencyKey: `ingest:${idempotencyKey}` });
        await tx.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "SYNTHETIC_IMPORT_QUEUED", resourceType: "IngestionBatch", resourceId: created.id } });
        return created;
      });
      return res.status(202).json({ batch, message: "Fictional records are queued for reconciliation; no institution is created automatically." });
    } catch (error) { return next(error); }
  });
  app.post("/ingestion/local-records", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const auth = req.authUser!;
      const body = z.object({ sourceName: z.string().trim().min(1).max(120), records: z.unknown() }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "Provide a sourceName and a records array." });
      const records = localJsonIngestionAdapter.parse(body.data.records);
      const canonical = JSON.stringify(records);
      const checksum = createHash("sha256").update(canonical).digest("hex");
      const header = req.header("Idempotency-Key");
      if (header && (header.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(header))) return res.status(400).json({ error: "Invalid Idempotency-Key header" });
      const idempotencyKey = `local:${auth.tenantId}:${header || checksum}`;
      const batch = await prisma.$transaction(async tx => {
        const created = await tx.ingestionBatch.upsert({ where: { idempotencyKey }, update: {}, create: { tenantId: auth.tenantId, createdByUserId: auth.userId, sourceName: body.data.sourceName, sourceType: "AUTHORIZED_LOCAL_JSON", sourceReference: "User-supplied local JSON records", sourceChecksum: checksum, totalRecords: records.length, idempotencyKey } });
        if (created.sourceChecksum !== checksum) throw new Error("Idempotency-Key was already used with different import content.");
        if (created.status === "QUEUED") await tx.ingestionRecord.createMany({ data: records.map(record => ({ batchId: created.id, sourceRecordKey: record.sourceRecordKey, normalizedData: record as unknown as import("@prisma/client").Prisma.InputJsonValue })), skipDuplicates: true });
        await enqueueJobEvent(tx, { tenantId: auth.tenantId, type: "INGEST_LOCAL", aggregateType: "IngestionBatch", aggregateId: created.id, payload: { batchId: created.id, requestedByUserId: auth.userId }, idempotencyKey: `ingest:${idempotencyKey}` });
        await tx.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "AUTHORIZED_LOCAL_IMPORT_QUEUED", resourceType: "IngestionBatch", resourceId: created.id, metadata: { sourceName: body.data.sourceName, records: records.length, checksum } } });
        return created;
      });
      return res.status(202).json({ batch, message: "Validated records queued for tenant-scoped reconciliation; no institution is created automatically." });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Import records failed validation", issues: error.issues.map(issue => ({ path: issue.path, message: issue.message })) });
      if (error instanceof Error && error.message.includes("Idempotency-Key was already used")) return res.status(409).json({ error: error.message });
      return next(error);
    }
  });
  app.patch("/ingestion/records/:id/review", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = reviewSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid import review input" });
      const auth = req.authUser!;
      const record = await prisma.ingestionRecord.findFirst({ where: { id: req.params.id, batch: { tenantId: auth.tenantId } }, include: { batch: true } });
      if (!record) return res.status(404).json({ error: "Import record not found" });
      if (["LINKED", "CREATED", "IGNORED"].includes(record.status)) return res.status(409).json({ error: "Import record has already been reviewed" });
      const source = record.normalizedData as Record<string, unknown>;
      const result = await prisma.$transaction(async tx => {
        let institutionId: string | null = null;
        let status: "LINKED" | "CREATED" | "IGNORED" = "IGNORED";
        if (parsed.data.action === "LINK_EXISTING") {
          const institution = await tx.institution.findFirst({ where: { id: parsed.data.institutionId, tenantId: auth.tenantId, archivedAt: null }, select: { id: true } });
          if (!institution) throw new Error("The selected institution is not available in this tenant.");
          institutionId = institution.id;
          status = "LINKED";
        } else if (parsed.data.action === "CREATE_NEW") {
          if (typeof source.name !== "string" || !["ENGINEERING", "MANAGEMENT", "PHARMACY", "OTHER"].includes(String(source.institutionType))) throw new Error("Imported institution fields failed validation.");
          const promoter = typeof source.promoterName === "string" && source.promoterName.length >= 2 ? await tx.promoter.create({ data: { name: source.promoterName } }) : null;
          const institution = await tx.institution.create({ data: { tenantId: auth.tenantId, name: source.name, institutionType: source.institutionType as "ENGINEERING" | "MANAGEMENT" | "PHARMACY" | "OTHER", createdByUserId: auth.userId, promoterId: promoter?.id } });
          institutionId = institution.id;
          status = "CREATED";
        }
        const updated = await tx.ingestionRecord.update({ where: { id: record.id }, data: { status, resolvedInstitutionId: institutionId, reviewNotes: parsed.data.notes, reviewedByUserId: auth.userId, reviewedAt: new Date() } });
        const linkedRecords = await tx.ingestionRecord.count({ where: { batchId: record.batchId, status: { in: ["LINKED", "CREATED"] } } });
        const ignoredRecords = await tx.ingestionRecord.count({ where: { batchId: record.batchId, status: "IGNORED" } });
        await tx.ingestionBatch.update({ where: { id: record.batchId }, data: { linkedRecords, ignoredRecords } });
        await tx.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: `INGESTION_RECORD_${parsed.data.action}`, resourceType: "IngestionRecord", resourceId: record.id, metadata: { batchId: record.batchId, resolvedInstitutionId: institutionId } } });
        return updated;
      });
      return res.json(result);
    } catch (error) {
      if (error instanceof Error && /not available in this tenant|failed validation/.test(error.message)) return res.status(400).json({ error: error.message });
      return next(error);
    }
  });
}
