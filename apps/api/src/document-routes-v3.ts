import type { Express, Request, Response, NextFunction } from "express";
import multer from "multer";
import { createHash } from "node:crypto";
import { z } from "zod";
import { requireAuth, requireRole } from "./security";
import { prisma } from "./db";
import { enqueueJobEvent } from "./job-service";
import { localDocumentStorage, safeDisplayName } from "./document-storage";

const maxUploadBytes = Number(process.env.FLOWGUARD_MAX_UPLOAD_BYTES || 10 * 1024 * 1024);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxUploadBytes, files: 1 }, fileFilter: (_req, file, callback) => {
  if (!["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype)) return callback(new Error("Only PDF, JPEG and PNG files are allowed"));
  callback(null, true);
} });

function signatureMatches(bytes: Buffer, mimeType: string) {
  if (mimeType === "application/pdf") return bytes.subarray(0, 5).toString() === "%PDF-";
  if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return false;
}

function safeError(error: unknown) {
  if (error instanceof Error && /file too large/i.test(error.message)) return { status: 413, message: "File exceeds the configured upload limit." };
  if (error instanceof Error && /only PDF/i.test(error.message)) return { status: 400, message: error.message };
  return { status: 400, message: "Upload could not be completed." };
}

export function registerDocumentRoutesV3(app: Express) {
  app.get("/documents", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
      const state = typeof req.query.processingState === "string" && ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"].includes(req.query.processingState) ? req.query.processingState as "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" : undefined;
      const items = await prisma.document.findMany({ where: { application: { tenantId: req.authUser!.tenantId }, ...(q ? { originalName: { contains: q, mode: "insensitive" } } : {}), ...(state ? { processingState: state } : {}) }, select: { id: true, applicationId: true, originalName: true, mimeType: true, checksumSha256: true, version: true, status: true, processingState: true, scanResult: true, uploadedAt: true, updatedAt: true, application: { select: { id: true, academicYear: true, institution: { select: { id: true, name: true } } } } }, orderBy: { uploadedAt: "desc" }, take: 200 });
      return res.json({ items });
    } catch (error) { return next(error); }
  });
  app.get("/applications/:applicationId/documents", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const application = await prisma.application.findFirst({ where: { id: String(req.params.applicationId), tenantId: req.authUser!.tenantId }, select: { id: true } });
      if (!application) return res.status(404).json({ error: "Application not found" });
      const items = await prisma.document.findMany({ where: { applicationId: application.id }, select: { id: true, originalName: true, mimeType: true, checksumSha256: true, version: true, status: true, processingState: true, scanResult: true, processingError: true, processingWarnings: true, processingAttempts: true, uploadedAt: true, updatedAt: true, extractions: { select: { id: true, fieldName: true, extractedValue: true, verifiedValue: true, confidence: true, confidenceBasis: true, pageNumber: true, sourceText: true, extractor: true, extractorVersion: true, humanVerified: true, verifiedByUserId: true, verifiedAt: true, reviewEvents: { select: { id: true, actorUserId: true, action: true, originalValue: true, reviewedValue: true, notes: true, createdAt: true }, orderBy: { createdAt: "desc" } } }, orderBy: { createdAt: "desc" } } }, orderBy: [{ originalName: "asc" }, { version: "desc" }], take: 300 });
      return res.json({ items });
    } catch (error) { return next(error); }
  });
  app.post("/applications/:applicationId/documents", requireAuth, (req: Request, res: Response, next: NextFunction) => {
    upload.single("file")(req, res, async uploadError => {
      if (uploadError) { const safe = safeError(uploadError); return res.status(safe.status).json({ error: safe.message }); }
      const file = req.file;
      if (!file) return res.status(400).json({ error: "Choose a PDF, JPEG or PNG file." });
      let storageKey: string | null = null;
      try {
        const auth = req.authUser!;
        const application = await prisma.application.findFirst({ where: { id: String(req.params.applicationId), tenantId: auth.tenantId }, select: { id: true } });
        if (!application) return res.status(404).json({ error: "Application not found" });
        if (!signatureMatches(file.buffer, file.mimetype)) return res.status(400).json({ error: "File signature does not match the allowed document type." });
        const savedStorageKey = await localDocumentStorage.put(file.buffer);
        storageKey = savedStorageKey;
        const originalName = safeDisplayName(file.originalname);
        const checksumSha256 = createHash("sha256").update(file.buffer).digest("hex");
        const result = await prisma.$transaction(async tx => {
          const previous = await tx.document.findFirst({ where: { applicationId: application.id, originalName }, orderBy: { version: "desc" }, select: { version: true } });
          const document = await tx.document.create({ data: { applicationId: application.id, storageKey: savedStorageKey, originalName, mimeType: file.mimetype, checksumSha256, version: (previous?.version ?? 0) + 1, uploadedByUserId: auth.userId, status: "QUARANTINED", processingState: "QUEUED", scanResult: "NOT_CONFIGURED" }, select: { id: true, originalName: true, mimeType: true, checksumSha256: true, version: true, status: true, processingState: true, scanResult: true, uploadedAt: true } });
          await enqueueJobEvent(tx, { tenantId: auth.tenantId, type: "PROCESS_DOCUMENT", aggregateType: "Document", aggregateId: document.id, payload: { documentId: document.id, requestedByUserId: auth.userId }, idempotencyKey: `process-document:${document.id}` });
          await tx.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "DOCUMENT_UPLOADED", resourceType: "Document", resourceId: document.id, metadata: { version: document.version, checksumSha256 } } });
          return document;
        });
        return res.status(202).json({ document: result, message: "Private upload saved and processing queued. The document remains quarantined until a configured scanner reports it clean." });
      } catch (error) {
        if (storageKey) await localDocumentStorage.remove(storageKey).catch(() => undefined);
        return next(error);
      }
    });
  });
  app.get("/documents/:documentId/versions", requireAuth, async (req, res, next) => {
    try {
      const document = await prisma.document.findFirst({ where: { id: req.params.documentId, application: { tenantId: req.authUser!.tenantId } }, select: { applicationId: true, originalName: true } });
      if (!document) return res.status(404).json({ error: "Document not found" });
      const items = await prisma.document.findMany({ where: { applicationId: document.applicationId, originalName: document.originalName }, select: { id: true, originalName: true, version: true, checksumSha256: true, status: true, processingState: true, scanResult: true, uploadedAt: true, updatedAt: true }, orderBy: { version: "desc" }, take: 100 });
      return res.json({ items });
    } catch (error) { return next(error); }
  });
  app.get("/documents/:documentId/download", requireAuth, async (req, res, next) => {
    try {
      const document = await prisma.document.findFirst({ where: { id: req.params.documentId, application: { tenantId: req.authUser!.tenantId } }, select: { storageKey: true, originalName: true, checksumSha256: true } });
      if (!document) return res.status(404).json({ error: "Document not found" });
      const bytes = await localDocumentStorage.read(document.storageKey);
      if (createHash("sha256").update(bytes).digest("hex") !== document.checksumSha256) return res.status(409).json({ error: "Stored file integrity check failed." });
      await prisma.auditEvent.create({ data: { tenantId: req.authUser!.tenantId, actorUserId: req.authUser!.userId, action: "DOCUMENT_DOWNLOADED", resourceType: "Document", resourceId: req.params.documentId } });
      const asciiName = document.originalName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(document.originalName)}`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      return res.send(bytes);
    } catch (error) { return next(error); }
  });
  app.post("/documents/:documentId/process", requireAuth, async (req, res, next) => {
    try {
      const auth = req.authUser!;
      const document = await prisma.document.findFirst({ where: { id: req.params.documentId, application: { tenantId: auth.tenantId } }, select: { id: true, applicationId: true, processingState: true, status: true } });
      if (!document) return res.status(404).json({ error: "Document not found" });
      if (document.status === "REJECTED") return res.status(409).json({ error: "Rejected documents cannot be reprocessed." });
      if (document.processingState === "RUNNING") return res.status(409).json({ error: "Document processing is already running." });
      const event = await prisma.$transaction(async tx => {
        await tx.document.update({ where: { id: document.id }, data: { processingState: "QUEUED", processingError: null } });
        await tx.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "DOCUMENT_REPROCESS_QUEUED", resourceType: "Document", resourceId: document.id } });
        return enqueueJobEvent(tx, { tenantId: auth.tenantId, type: "PROCESS_DOCUMENT", aggregateType: "Document", aggregateId: document.id, payload: { documentId: document.id, requestedByUserId: auth.userId }, idempotencyKey: `process-document:${document.id}:manual:${Date.now()}` });
      });
      return res.status(202).json({ queued: true, eventId: event.id });
    } catch (error) { return next(error); }
  });
  app.post("/documents/:documentId/extractions/:extractionId/verify", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = z.object({ verifiedValue: z.string().max(5000).optional(), notes: z.string().trim().max(2000).optional() }).safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid evidence review input" });
      const auth = req.authUser!;
      const extraction = await prisma.evidenceExtraction.findFirst({ where: { id: req.params.extractionId, documentId: req.params.documentId, document: { application: { tenantId: auth.tenantId } } }, include: { document: { select: { id: true, applicationId: true } } } });
      if (!extraction) return res.status(404).json({ error: "Evidence field not found." });
      const corrected = Object.prototype.hasOwnProperty.call(parsed.data, "verifiedValue");
      const reviewedValue = corrected ? parsed.data.verifiedValue : extraction.verifiedValue ?? extraction.extractedValue;
      const action = corrected && JSON.stringify(reviewedValue) !== JSON.stringify(extraction.verifiedValue ?? extraction.extractedValue) ? "CORRECTED" : "VERIFIED";
      const result = await prisma.$transaction(async tx => {
        const updated = await tx.evidenceExtraction.update({ where: { id: extraction.id }, data: { humanVerified: true, verifiedByUserId: auth.userId, verifiedAt: new Date(), verifiedValue: reviewedValue as any } });
        await tx.evidenceReviewEvent.create({ data: { extractionId: extraction.id, actorUserId: auth.userId, action, originalValue: (extraction.verifiedValue ?? extraction.extractedValue) as any, reviewedValue: reviewedValue as any, notes: parsed.data.notes } });
        await tx.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: action === "CORRECTED" ? "EVIDENCE_EXTRACTION_CORRECTED" : "EVIDENCE_EXTRACTION_VERIFIED", resourceType: "EvidenceExtraction", resourceId: extraction.id, metadata: { documentId: extraction.documentId, pageNumber: extraction.pageNumber } } });
        await enqueueJobEvent(tx, { tenantId: auth.tenantId, type: "ANALYZE_COMPLIANCE", aggregateType: "Application", aggregateId: extraction.document.applicationId, payload: { applicationId: extraction.document.applicationId, requestedByUserId: auth.userId }, idempotencyKey: `analysis-after-review:${extraction.id}:${Date.now()}` });
        return updated;
      });
      return res.json({ id: result.id, fieldName: result.fieldName, extractedValue: result.extractedValue, verifiedValue: result.verifiedValue, sourceText: result.sourceText, pageNumber: result.pageNumber, humanVerified: result.humanVerified, verifiedAt: result.verifiedAt, verifiedByUserId: result.verifiedByUserId, action });
    } catch (error) { return next(error); }
  });
}
