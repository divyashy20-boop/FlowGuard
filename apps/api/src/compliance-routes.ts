import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "./db.js";
import { requireAuth } from "./security.js";
import { enqueueJobEvent } from "./job-service";

const router = Router();
const linkSchema = z.object({ documentId: z.string().min(1).max(200) });

function tenantId(req: Request): string {
  return (req as any).authUser.tenantId;
}
function actor(req: Request): any {
  return (req as any).authUser;
}
function allowed(req: Request, roles: string[]): boolean {
  return roles.includes(actor(req)?.role);
}

router.get(
  "/applications/:applicationId/compliance",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const app = await prisma.application.findFirst({
        where: { id: String(req.params.applicationId), tenantId: tenantId(req) },
        include: {
          workflow: {
            include: {
              requirements: {
                orderBy: { code: "asc" },
                include: {
                  evidence: {
                    include: {
                      document: {
                        select: {
                          id: true, originalName: true, mimeType: true,
                          status: true, processingState: true, scanResult: true, version: true, uploadedAt: true,
                          extractions: {
                            select: {
                              id: true, fieldName: true, humanVerified: true,
                              verifiedAt: true, extractedValue: true, verifiedValue: true,
                              pageNumber: true, sourceText: true, extractor: true, extractorVersion: true
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      });

      if (!app) return res.status(404).json({ error: "Application not found." });
      const [analysis, findings] = await Promise.all([
        prisma.complianceAnalysis.findFirst({ where: { applicationId: app.id, tenantId: tenantId(req) } }),
        prisma.complianceFinding.findMany({ where: { applicationId: app.id, tenantId: tenantId(req) }, orderBy: [{ status: "asc" }, { severity: "desc" }, { updatedAt: "desc" }], take: 200 })
      ]);
      const intelligence = {
        readinessEstimate: analysis ? { value: analysis.readinessEstimate, label: "Readiness estimate", computedAt: analysis.computedAt, ruleVersion: analysis.ruleVersion, meaning: "Not an official AICTE score, approval prediction, or compliance certification." } : null,
        findings
      };
      if (!app.workflow) {
        return res.json({
          applicationId: app.id,
          workflowId: null,
          message: "No workflow is assigned to this application.",
          items: [],
          ...intelligence
        });
      }

      const items = app.workflow.requirements.map((r: any) => {
        const linked = r.evidence.map((e: any) => e.document);
        const extractionCount = linked.reduce(
          (n: number, d: any) => n + d.extractions.length, 0
        );
        const verifiedCount = linked.reduce(
          (n: number, d: any) => n + d.extractions.filter((x: any) => x.humanVerified).length, 0
        );
        let evidenceStatus = "MISSING_EVIDENCE";
        if (linked.length && extractionCount === 0) evidenceStatus = "EVIDENCE_LINKED";
        if (extractionCount > 0 && verifiedCount === 0) evidenceStatus = "EXTRACTION_REVIEW_PENDING";
        if (verifiedCount > 0) evidenceStatus = "FIELD_REVIEWED";

        return {
          id: r.id,
          code: r.code,
          description: r.description,
          mandatory: r.mandatory,
          evidenceStatus,
          linkedDocuments: linked,
          extractionCount,
          verifiedFieldCount: verifiedCount
        };
      });

      return res.json({
        applicationId: app.id,
        workflowId: app.workflowId,
        workflowCategory: app.workflow.category,
        workflowVersion: app.workflow.version,
        items,
        ...intelligence
      });
    } catch (err) { next(err); }
  }
);

router.post(
  "/applications/:applicationId/requirements/:requirementId/evidence",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!allowed(req, ["ADMIN", "REVIEWER", "INSTITUTION_USER"])) {
        return res.status(403).json({ error: "You cannot link evidence with this role." });
      }
      const parsed = linkSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request.", details: parsed.error.flatten() });
      }

      const application = await prisma.application.findFirst({
        where: { id: String(req.params.applicationId), tenantId: tenantId(req) },
        select: { id: true, workflowId: true, tenantId: true }
      });
      if (!application) return res.status(404).json({ error: "Application not found." });
      if (!application.workflowId) {
        return res.status(409).json({ error: "Assign a workflow before linking requirement evidence." });
      }

      const requirement = await prisma.requirement.findFirst({
        where: { id: String(req.params.requirementId), workflowId: application.workflowId },
        select: { id: true, workflowId: true, code: true }
      });
      if (!requirement) {
        return res.status(400).json({ error: "Requirement does not belong to this application's workflow." });
      }

      const document = await prisma.document.findFirst({
        where: {
          id: parsed.data.documentId,
          applicationId: application.id,
          application: { tenantId: tenantId(req) }
        },
        select: { id: true, originalName: true, status: true }
      });
      if (!document) {
        return res.status(400).json({ error: "Document must belong to this application." });
      }
      if (document.status === "REJECTED") {
        return res.status(409).json({ error: "Rejected documents cannot be linked as evidence." });
      }

      const existing = await prisma.requirementEvidence.findFirst({
        where: { requirementId: requirement.id, documentId: document.id }
      });
      if (existing) {
        return res.json({ item: existing, message: "This document is already linked." });
      }

      const link = await prisma.$transaction(async tx => {
        const item = await tx.requirementEvidence.create({ data: { requirementId: requirement.id, documentId: document.id, linkedByUserId: actor(req).userId } });
        await tx.auditEvent.create({ data: { tenantId: tenantId(req), actorUserId: actor(req).userId, action: "REQUIREMENT_EVIDENCE_LINKED", resourceType: "RequirementEvidence", resourceId: item.id, metadata: { applicationId: application.id, requirementId: requirement.id, requirementCode: requirement.code, documentId: document.id } } });
        await enqueueJobEvent(tx, { tenantId: tenantId(req), type: "ANALYZE_COMPLIANCE", aggregateType: "Application", aggregateId: application.id, payload: { applicationId: application.id, requestedByUserId: actor(req).userId }, idempotencyKey: `analysis-after-evidence:${item.id}` });
        return item;
      });

      return res.status(201).json({
        item: link,
        message: "Evidence linked. This does not itself mean the requirement is compliant."
      });
    } catch (err: any) {
      if (err?.code === "P2002") {
        return res.status(409).json({ error: "This evidence link already exists." });
      }
      next(err);
    }
  }
);

router.delete(
  "/applications/:applicationId/requirements/:requirementId/evidence/:documentId",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!allowed(req, ["ADMIN", "REVIEWER", "INSTITUTION_USER"])) {
        return res.status(403).json({ error: "You cannot unlink evidence with this role." });
      }

      const application = await prisma.application.findFirst({
        where: { id: String(req.params.applicationId), tenantId: tenantId(req) },
        select: { id: true, workflowId: true }
      });
      if (!application) return res.status(404).json({ error: "Application not found." });

      const requirement = await prisma.requirement.findFirst({
        where: { id: String(req.params.requirementId), workflowId: application.workflowId ?? "__none__" },
        select: { id: true }
      });
      if (!requirement) return res.status(400).json({ error: "Requirement does not belong to this application workflow." });

      const documentId = String(req.params.documentId);
      const result = await prisma.$transaction(async tx => {
        const deleted = await tx.requirementEvidence.deleteMany({ where: { requirementId: requirement.id, documentId, document: { applicationId: application.id, application: { tenantId: tenantId(req) } } } });
        if (deleted.count) {
          await tx.auditEvent.create({ data: { tenantId: tenantId(req), actorUserId: actor(req).userId, action: "REQUIREMENT_EVIDENCE_UNLINKED", resourceType: "RequirementEvidence", resourceId: `${requirement.id}:${documentId}` } });
          await enqueueJobEvent(tx, { tenantId: tenantId(req), type: "ANALYZE_COMPLIANCE", aggregateType: "Application", aggregateId: application.id, payload: { applicationId: application.id, requestedByUserId: actor(req).userId }, idempotencyKey: `analysis-after-unlink:${application.id}:${requirement.id}:${documentId}:${Date.now()}` });
        }
        return deleted;
      });
      if (!result.count) return res.status(404).json({ error: "Evidence link not found." });
      return res.json({ ok: true, message: "Evidence link removed." });
    } catch (err) { next(err); }
  }
);

export default router;
