import type { Express } from "express";
import { z } from "zod";
import { prisma } from "./db";
import { requireAuth, requireRole } from "./security";
import { enqueueJob } from "./job-service";

export function registerJobRoutes(app: Express) {
  app.get("/jobs", requireAuth, async (req, res, next) => {
    try {
      const status = typeof req.query.status === "string" && ["PENDING", "RUNNING", "RETRY", "COMPLETED", "DEAD_LETTER"].includes(req.query.status) ? req.query.status as "PENDING" | "RUNNING" | "RETRY" | "COMPLETED" | "DEAD_LETTER" : undefined;
      const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
      const items = await prisma.backgroundJob.findMany({ where: { tenantId: req.authUser!.tenantId, ...(status ? { status } : {}), ...(q ? { type: { contains: q, mode: "insensitive" } } : {}) }, select: { id: true, type: true, status: true, attempts: true, maxAttempts: true, progress: true, progressMessage: true, availableAt: true, startedAt: true, completedAt: true, lastError: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 100 });
      return res.json({ items });
    } catch (error) { return next(error); }
  });
  app.get("/compliance-findings", requireAuth, async (req, res, next) => {
    try {
      const auth = req.authUser!;
      const status = typeof req.query.status === "string" && ["OPEN", "ACKNOWLEDGED", "RESOLVED", "DISMISSED"].includes(req.query.status) ? req.query.status as "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "DISMISSED" : undefined;
      const severity = typeof req.query.severity === "string" && ["INFO", "WARNING", "HIGH"].includes(req.query.severity) ? req.query.severity as "INFO" | "WARNING" | "HIGH" : undefined;
      const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
      const items = await prisma.complianceFinding.findMany({ where: { tenantId: auth.tenantId, ...(status ? { status } : {}), ...(severity ? { severity } : {}), ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { code: { contains: q, mode: "insensitive" } }, { explanation: { contains: q, mode: "insensitive" } }] } : {}) }, include: { application: { select: { id: true, applicationNumber: true, academicYear: true, institution: { select: { id: true, name: true } } } }, requirement: { select: { code: true, description: true } } }, orderBy: [{ severity: "desc" }, { updatedAt: "desc" }], take: 200 });
      return res.json({ items });
    } catch (error) { return next(error); }
  });
  app.get("/matches", requireAuth, async (req, res, next) => {
    try {
      const auth = req.authUser!;
      const status = typeof req.query.status === "string" && ["SUGGESTED", "CONFIRMED_POTENTIAL", "DISMISSED", "DEFERRED"].includes(req.query.status) ? req.query.status as "SUGGESTED" | "CONFIRMED_POTENTIAL" | "DISMISSED" | "DEFERRED" : undefined;
      const items = await prisma.matchCandidate.findMany({ where: { tenantId: auth.tenantId, ...(status ? { reviewStatus: status } : {}) }, include: { leftApplication: { select: { id: true, applicationNumber: true, academicYear: true, institution: { select: { id: true, name: true } } } }, rightApplication: { select: { id: true, applicationNumber: true, academicYear: true, institution: { select: { id: true, name: true } } } } }, orderBy: [{ reviewStatus: "asc" }, { score: "desc" }], take: 200 });
      return res.json({ items });
    } catch (error) { return next(error); }
  });
  app.get("/jobs/:id", requireAuth, async (req, res, next) => {
    try {
      const item = await prisma.backgroundJob.findFirst({ where: { id: req.params.id, tenantId: req.authUser!.tenantId }, select: { id: true, type: true, status: true, attempts: true, maxAttempts: true, progress: true, progressMessage: true, availableAt: true, startedAt: true, completedAt: true, lastError: true, createdAt: true } });
      return item ? res.json(item) : res.status(404).json({ error: "Job not found" });
    } catch (error) { return next(error); }
  });
  app.post("/jobs/:id/replay", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
    try {
      const auth = req.authUser!;
      const job = await prisma.backgroundJob.findFirst({ where: { id: req.params.id, tenantId: auth.tenantId } });
      if (!job) return res.status(404).json({ error: "Job not found" });
      if (job.status !== "DEAD_LETTER") return res.status(409).json({ error: "Only dead-letter jobs can be replayed" });
      const replay = await prisma.$transaction(async tx => {
        const updated = await tx.backgroundJob.create({ data: { tenantId: job.tenantId, type: job.type, status: "PENDING", idempotencyKey: `${job.idempotencyKey}:replay:${Date.now()}`, payload: job.payload, maxAttempts: job.maxAttempts } });
        await tx.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "BACKGROUND_JOB_REPLAYED", resourceType: "BackgroundJob", resourceId: updated.id, metadata: { originalJobId: job.id, type: job.type } } });
        return updated;
      });
      return res.status(202).json({ id: replay.id, status: replay.status });
    } catch (error) { return next(error); }
  });
  app.post("/applications/:id/compliance/refresh", requireAuth, requireRole("ADMIN", "REVIEWER", "INSTITUTION_USER"), async (req, res, next) => {
    try {
      const auth = req.authUser!;
      const application = await prisma.application.findFirst({ where: { id: req.params.id, tenantId: auth.tenantId }, select: { id: true } });
      if (!application) return res.status(404).json({ error: "Application not found" });
      const event = await enqueueJob({ tenantId: auth.tenantId, type: "ANALYZE_COMPLIANCE", aggregateType: "Application", aggregateId: application.id, payload: { applicationId: application.id, requestedByUserId: auth.userId }, idempotencyKey: `analysis:${application.id}:${Date.now()}` });
      return res.status(202).json({ queued: true, eventId: event.id, message: "Compliance analysis queued. Readiness is an estimate, not a certification." });
    } catch (error) { return next(error); }
  });
  app.post("/applications/:id/matches/refresh", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const auth = req.authUser!;
      const application = await prisma.application.findFirst({ where: { id: req.params.id, tenantId: auth.tenantId }, select: { id: true } });
      if (!application) return res.status(404).json({ error: "Application not found" });
      const event = await enqueueJob({ tenantId: auth.tenantId, type: "MATCH_APPLICATION", aggregateType: "Application", aggregateId: application.id, payload: { applicationId: application.id, requestedByUserId: auth.userId }, idempotencyKey: `match:${application.id}:${Date.now()}` });
      return res.status(202).json({ queued: true, eventId: event.id });
    } catch (error) { return next(error); }
  });
  app.get("/notifications", requireAuth, async (req, res, next) => {
    try {
      const auth = req.authUser!;
      const unreadOnly = req.query.unread === "true";
      const [items, unreadCount] = await Promise.all([
        prisma.notification.findMany({ where: { tenantId: auth.tenantId, userId: auth.userId, ...(unreadOnly ? { readAt: null } : {}) }, orderBy: { createdAt: "desc" }, take: 100 }),
        prisma.notification.count({ where: { tenantId: auth.tenantId, userId: auth.userId, readAt: null } })
      ]);
      return res.json({ items, unreadCount });
    } catch (error) { return next(error); }
  });
  app.post("/notifications/:id/read", requireAuth, async (req, res, next) => {
    try {
      const auth = req.authUser!;
      const updated = await prisma.notification.updateMany({ where: { id: req.params.id, tenantId: auth.tenantId, userId: auth.userId, readAt: null }, data: { readAt: new Date() } });
      if (!updated.count) return res.status(404).json({ error: "Unread notification not found" });
      return res.json({ ok: true });
    } catch (error) { return next(error); }
  });
  app.post("/compliance-findings/:id/review", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = z.object({ status: z.enum(["ACKNOWLEDGED", "RESOLVED", "DISMISSED"]), resolutionNotes: z.string().trim().max(2000).optional() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid finding review input" });
      const auth = req.authUser!;
      const finding = await prisma.complianceFinding.findFirst({ where: { id: req.params.id, tenantId: auth.tenantId } });
      if (!finding) return res.status(404).json({ error: "Compliance finding not found" });
      const result = await prisma.$transaction(async tx => {
        const updated = await tx.complianceFinding.update({ where: { id: finding.id }, data: { status: parsed.data.status, resolutionNotes: parsed.data.resolutionNotes, resolvedByUserId: auth.userId, lastRefreshedAt: new Date() } });
        await tx.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "COMPLIANCE_FINDING_REVIEWED", resourceType: "ComplianceFinding", resourceId: finding.id, metadata: { status: parsed.data.status } } });
        return updated;
      });
      return res.json(result);
    } catch (error) { return next(error); }
  });
}
