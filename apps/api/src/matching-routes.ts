import type { Express } from "express";
import { z } from "zod";
import { prisma } from "./db";
import { requireAuth, requireRole } from "./security";

export function registerMatchingRoutes(app: Express) {
  app.get("/applications/:id/matches", requireAuth, async (req, res, next) => {
    try {
      const tenantId = req.authUser!.tenantId;
      const application = await prisma.application.findFirst({ where: { id: req.params.id, tenantId }, select: { id: true } });
      if (!application) return res.status(404).json({ error: "Application not found" });
      const items = await prisma.matchCandidate.findMany({ where: { tenantId, OR: [{ leftApplicationId: application.id }, { rightApplicationId: application.id }] }, include: { leftApplication: { select: { id: true, academicYear: true, applicationNumber: true, institution: { select: { id: true, name: true } } } }, rightApplication: { select: { id: true, academicYear: true, applicationNumber: true, institution: { select: { id: true, name: true } } } } }, orderBy: [{ reviewStatus: "asc" }, { score: "desc" }], take: 100 });
      return res.json({ items });
    } catch (error) { return next(error); }
  });
  app.patch("/matches/:id/review", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = z.object({ status: z.enum(["CONFIRMED_POTENTIAL", "DISMISSED", "DEFERRED"]), notes: z.string().trim().max(2000).optional() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid matching review input" });
      const auth = req.authUser!;
      const match = await prisma.matchCandidate.findFirst({ where: { id: req.params.id, tenantId: auth.tenantId } });
      if (!match) return res.status(404).json({ error: "Match candidate not found" });
      const result = await prisma.$transaction(async tx => {
        const updated = await tx.matchCandidate.update({ where: { id: match.id }, data: { reviewStatus: parsed.data.status, reviewNotes: parsed.data.notes, reviewedByUserId: auth.userId, reviewedAt: new Date() } });
        await tx.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "MATCH_CANDIDATE_REVIEWED", resourceType: "MatchCandidate", resourceId: match.id, metadata: { status: parsed.data.status } } });
        return updated;
      });
      return res.json(result);
    } catch (error) { return next(error); }
  });
}
