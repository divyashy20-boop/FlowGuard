import type { Express } from "express";
import { z } from "zod";
import { prisma } from "./db";
import { requireAuth, requireRole } from "./security";
import { decodeApplicationCursor, encodeApplicationCursor } from "./application-cursor";


function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
const createApplicationSchema = z.object({
  institutionId: z.string().min(1).max(100),
  campusId: z.string().min(1).max(100).nullable().optional(),
  programmeId: z.string().min(1).max(100).nullable().optional(),
  workflowId: z.string().min(1).max(100).nullable().optional(),
  academicYear: z.string().trim().min(4).max(20)
});

const deficiencySchema = z.object({
  code: z.string().trim().min(1).max(80),
  description: z.string().trim().min(3).max(2000)
});
const deficiencyResponseSchema = z.object({ responseText: z.string().trim().min(3).max(4000) });

const decisionSchema = z.object({
  outcome: z.enum(["APPROVED", "REJECTED", "WITHDRAWN"]),
  authority: z.string().trim().min(2).max(200),
  reference: z.string().trim().max(200).optional()
});

const applicationStatuses = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "DEFICIENCY_RAISED",
  "RESUBMITTED",
  "DECISION_ISSUED"
] as const;

export function registerApplicationRoutes(app: Express) {
  app.get("/applications", requireAuth, async (req, res, next) => {
    try {
      const rawStatus = req.query.status;
      const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
      const academicYear = typeof req.query.academicYear === "string" ? req.query.academicYear.trim().slice(0, 20) : "";
      const workflowCategory = typeof req.query.workflowCategory === "string" ? req.query.workflowCategory.trim().slice(0, 80) : "";
      const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));
      const pageSize = Math.max(1, Math.min(100, Number(req.query.pageSize) || 100));
      if (req.query.pagination !== undefined && req.query.pagination !== "cursor") return res.status(400).json({ error: "Unsupported pagination mode" });
      if (req.query.cursor !== undefined && typeof req.query.cursor !== "string") return res.status(400).json({ error: "Invalid application cursor" });
      const cursorValue = typeof req.query.cursor === "string" ? req.query.cursor : "";
      const cursorMode = req.query.pagination === "cursor" || Boolean(cursorValue);
      const cursor = cursorValue ? decodeApplicationCursor(cursorValue) : null;
      if (cursorValue && !cursor) return res.status(400).json({ error: "Invalid application cursor" });
      if (
        rawStatus !== undefined &&
        (typeof rawStatus !== "string" ||
          !applicationStatuses.includes(rawStatus as typeof applicationStatuses[number]))
      ) {
        return res.status(400).json({ error: "Invalid application status filter" });
      }

      const where = {
          tenantId: req.authUser!.tenantId,
          ...(q ? { OR: [{ institution: { name: { contains: q, mode: "insensitive" as const } } }, { applicationNumber: { contains: q, mode: "insensitive" as const } }, { campus: { name: { contains: q, mode: "insensitive" as const } } }, { programme: { name: { contains: q, mode: "insensitive" as const } } }] } : {}),
          ...(academicYear ? { academicYear: { contains: academicYear, mode: "insensitive" as const } } : {}),
          ...(workflowCategory ? { workflow: { category: { contains: workflowCategory, mode: "insensitive" as const } } } : {}),
          ...(typeof rawStatus === "string"
            ? { status: rawStatus as typeof applicationStatuses[number] }
            : {})
        };
      const items = await prisma.application.findMany({
        where: cursor ? { AND: [where, { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] } : where,
        select: {
          id: true,
          applicationNumber: true,
          status: true,
          academicYear: true,
          submittedAt: true,
          createdAt: true,
          updatedAt: true,
          institution: { select: { id: true, name: true, institutionType: true } },
          campus: { select: { id: true, name: true } },
          programme: { select: { id: true, name: true, discipline: true } },
          workflow: { select: { id: true, category: true, version: true } }
        },
        orderBy: cursorMode ? [{ createdAt: "desc" }, { id: "desc" }] : { updatedAt: "desc" },
        skip: cursorMode ? undefined : (page - 1) * pageSize,
        take: pageSize + (cursorMode ? 1 : 0)
      });

      if (!cursorMode) {
        const total = await prisma.application.count({ where });
        return res.json({ items, total, page, pageSize });
      }
      const hasMore = items.length > pageSize;
      const pageItems = items.slice(0, pageSize);
      const nextCursor = hasMore && pageItems.length
        ? encodeApplicationCursor({ id: pageItems[pageItems.length - 1].id, createdAt: pageItems[pageItems.length - 1].createdAt })
        : undefined;
      return res.json({ items: pageItems, pageSize, hasMore, ...(nextCursor ? { nextCursor } : {}) });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/applications", requireAuth, async (req, res, next) => {
    try {
      const parsed = createApplicationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid application input" });
      }

      const auth = req.authUser!;
      const input = parsed.data;

      const institution = await prisma.institution.findFirst({
        where: {
          id: input.institutionId,
          tenantId: auth.tenantId,
          archivedAt: null
        },
        select: { id: true }
      });

      if (!institution) {
        return res.status(404).json({ error: "Institution not found" });
      }

      if (input.campusId) {
        const campus = await prisma.campus.findFirst({
          where: { id: input.campusId, institutionId: institution.id },
          select: { id: true }
        });
        if (!campus) {
          return res.status(400).json({
            error: "Campus does not belong to the selected institution"
          });
        }
      }

      if (input.programmeId) {
        const programme = await prisma.programme.findUnique({
          where: { id: input.programmeId },
          select: { id: true }
        });
        if (!programme) {
          return res.status(400).json({ error: "Programme not found" });
        }
      }

      if (input.workflowId) {
        const workflow = await prisma.workflowDefinition.findFirst({
          where: { id: input.workflowId, active: true },
          select: { id: true }
        });
        if (!workflow) {
          return res.status(400).json({ error: "Selected workflow is not active" });
        }
      }

      const application = await prisma.application.create({
        data: {
          tenantId: auth.tenantId,
          institutionId: institution.id,
          campusId: input.campusId ?? null,
          programmeId: input.programmeId ?? null,
          workflowId: input.workflowId ?? null,
          academicYear: input.academicYear
        },
        select: {
          id: true,
          status: true,
          academicYear: true,
          createdAt: true,
          institution: { select: { id: true, name: true } },
          workflow: { select: { id: true, category: true, version: true } }
        }
      });

      await prisma.auditEvent.create({
        data: {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: "APPLICATION_CREATED",
          resourceType: "Application",
          resourceId: application.id
        }
      });

      return res.status(201).json(application);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/applications/:id", requireAuth, async (req, res, next) => {
    try {
      const application = await prisma.application.findFirst({
        where: {
          id: routeParam(req.params.id),
          tenantId: req.authUser!.tenantId
        },
        include: {
          institution: { select: { id: true, name: true, institutionType: true } },
          campus: { select: { id: true, name: true, address: true } },
          programme: { select: { id: true, name: true, discipline: true } },
          workflow: {
            include: {
              requirements: {
                select: { id: true, code: true, description: true, mandatory: true }
              }
            }
          },
          deficiencies: {
            select: {
              id: true, code: true, description: true, status: true,
              raisedAt: true, closedAt: true, responseText: true, responseSubmittedByUserId: true, responseSubmittedAt: true
            },
            orderBy: { raisedAt: "desc" }
          },
          reviews: {
            select: {
              id: true, reviewerId: true, status: true, notes: true,
              startedAt: true, completedAt: true
            }
          },
          decisions: {
            select: {
              id: true, outcome: true, issuedAt: true, authority: true,
              reference: true, letterStorageKey: true
            },
            orderBy: { issuedAt: "desc" }
          }
        }
      });

      if (!application) return res.status(404).json({ error: "Application not found" });
      return res.json(application);
    } catch (error) {
      return next(error);
    }
  });

  app.post(
    "/applications/:id/submit",
    requireAuth,
    requireRole("ADMIN", "INSTITUTION_USER"),
    async (req, res, next) => {
      try {
        const auth = req.authUser!;
        const application = await prisma.application.findFirst({
          where: { id: routeParam(req.params.id), tenantId: auth.tenantId }
        });

        if (!application) return res.status(404).json({ error: "Application not found" });
        if (application.status !== "DRAFT") {
          return res.status(409).json({ error: "Only draft applications can be submitted" });
        }

        const updated = await prisma.$transaction(async (tx) => {
          const result = await tx.application.update({
            where: { id: application.id },
            data: { status: "SUBMITTED", submittedAt: new Date() }
          });

          await tx.auditEvent.create({
            data: {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: "APPLICATION_SUBMITTED",
              resourceType: "Application",
              resourceId: application.id
            }
          });

          return result;
        });

        return res.json({ id: updated.id, status: updated.status, submittedAt: updated.submittedAt });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/applications/:id/start-review",
    requireAuth,
    requireRole("ADMIN", "REVIEWER"),
    async (req, res, next) => {
      try {
        const auth = req.authUser!;
        const application = await prisma.application.findFirst({
          where: { id: routeParam(req.params.id), tenantId: auth.tenantId }
        });

        if (!application) return res.status(404).json({ error: "Application not found" });
        if (!["SUBMITTED", "RESUBMITTED"].includes(application.status)) {
          return res.status(409).json({
            error: "Only submitted or resubmitted applications can enter review"
          });
        }

        const result = await prisma.$transaction(async (tx) => {
          const review = await tx.review.create({
            data: {
              tenantId: auth.tenantId,
              applicationId: application.id,
              reviewerId: auth.userId,
              status: "IN_PROGRESS",
              startedAt: new Date()
            }
          });

          await tx.application.update({
            where: { id: application.id },
            data: { status: "UNDER_REVIEW" }
          });

          await tx.auditEvent.create({
            data: {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: "APPLICATION_REVIEW_STARTED",
              resourceType: "Application",
              resourceId: application.id
            }
          });

          return review;
        });

        return res.status(201).json(result);
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/applications/:id/deficiencies",
    requireAuth,
    requireRole("ADMIN", "REVIEWER"),
    async (req, res, next) => {
      try {
        const parsed = deficiencySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid deficiency input" });
        }

        const auth = req.authUser!;
        const application = await prisma.application.findFirst({
          where: { id: routeParam(req.params.id), tenantId: auth.tenantId }
        });

        if (!application) return res.status(404).json({ error: "Application not found" });
        if (application.status !== "UNDER_REVIEW") {
          return res.status(409).json({ error: "Application is not under review" });
        }

        const result = await prisma.$transaction(async (tx) => {
          const deficiency = await tx.deficiency.create({
            data: {
              tenantId: auth.tenantId,
              applicationId: application.id,
              code: parsed.data.code,
              description: parsed.data.description
            }
          });

          await tx.application.update({
            where: { id: application.id },
            data: { status: "DEFICIENCY_RAISED" }
          });

          await tx.auditEvent.create({
            data: {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: "DEFICIENCY_RAISED",
              resourceType: "Deficiency",
              resourceId: deficiency.id
            }
          });

          return deficiency;
        });

        return res.status(201).json(result);
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/deficiencies/:id/respond",
    requireAuth,
    requireRole("ADMIN", "INSTITUTION_USER"),
    async (req, res, next) => {
      try {
        const parsed = deficiencyResponseSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "Enter a response of at least 3 characters." });
        const auth = req.authUser!;
        const deficiency = await prisma.deficiency.findFirst({
          where: { id: routeParam(req.params.id), tenantId: auth.tenantId }
        });

        if (!deficiency) return res.status(404).json({ error: "Deficiency not found" });
        if (deficiency.status !== "OPEN") {
          return res.status(409).json({ error: "Only open deficiencies can receive a response" });
        }

        const updated = await prisma.deficiency.update({
          where: { id: deficiency.id },
          data: { status: "RESPONSE_SUBMITTED", responseText: parsed.data.responseText, responseSubmittedByUserId: auth.userId, responseSubmittedAt: new Date() }
        });

        await prisma.auditEvent.create({
          data: {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: "DEFICIENCY_RESPONSE_SUBMITTED",
            resourceType: "Deficiency",
              resourceId: deficiency.id,
              metadata: { responseLength: parsed.data.responseText.length }
          }
        });

        return res.json(updated);
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/deficiencies/:id/close",
    requireAuth,
    requireRole("ADMIN", "REVIEWER"),
    async (req, res, next) => {
      try {
        const auth = req.authUser!;
        const deficiency = await prisma.deficiency.findFirst({
          where: { id: routeParam(req.params.id), tenantId: auth.tenantId }
        });

        if (!deficiency) return res.status(404).json({ error: "Deficiency not found" });
        if (deficiency.status !== "RESPONSE_SUBMITTED") {
          return res.status(409).json({
            error: "A deficiency must have a submitted response before closure"
          });
        }

        const result = await prisma.$transaction(async (tx) => {
          const updated = await tx.deficiency.update({
            where: { id: deficiency.id },
            data: { status: "CLOSED", closedAt: new Date() }
          });

          const remaining = await tx.deficiency.count({
            where: {
              applicationId: deficiency.applicationId,
              status: { not: "CLOSED" }
            }
          });

          if (remaining === 0) {
            await tx.application.updateMany({
              where: {
                id: deficiency.applicationId,
                tenantId: auth.tenantId,
                status: "DEFICIENCY_RAISED"
              },
              data: { status: "RESUBMITTED" }
            });
          }

          await tx.auditEvent.create({
            data: {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: "DEFICIENCY_CLOSED",
              resourceType: "Deficiency",
              resourceId: deficiency.id
            }
          });

          return updated;
        });

        return res.json(result);
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/applications/:id/decision",
    requireAuth,
    requireRole("ADMIN"),
    async (req, res, next) => {
      try {
        const parsed = decisionSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid formal decision input" });
        }

        const auth = req.authUser!;
        const application = await prisma.application.findFirst({
          where: { id: routeParam(req.params.id), tenantId: auth.tenantId }
        });

        if (!application) return res.status(404).json({ error: "Application not found" });
        if (!["UNDER_REVIEW", "RESUBMITTED"].includes(application.status)) {
          return res.status(409).json({
            error: "Application must be under review or resubmitted before recording a decision"
          });
        }

        const unresolved = await prisma.deficiency.count({
          where: {
            applicationId: application.id,
            status: { not: "CLOSED" }
          }
        });

        if (unresolved > 0) {
          return res.status(409).json({
            error: "All deficiencies must be closed before a formal decision is recorded"
          });
        }

        const decision = await prisma.$transaction(async (tx) => {
          const created = await tx.formalDecision.create({
            data: {
              applicationId: application.id,
              outcome: parsed.data.outcome,
              issuedAt: new Date(),
              authority: parsed.data.authority,
              reference: parsed.data.reference
            }
          });

          await tx.application.update({
            where: { id: application.id },
            data: { status: "DECISION_ISSUED" }
          });

          await tx.auditEvent.create({
            data: {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: "FORMAL_DECISION_ISSUED",
              resourceType: "FormalDecision",
              resourceId: created.id
            }
          });

          return created;
        });

        return res.status(201).json({
          decision,
          applicationStatus: "DECISION_ISSUED",
          note: "A formal decision record does not by itself establish approval validity or availability of an approval letter."
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post("/reviews/:id/complete", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = z.object({ notes: z.string().trim().max(10000).optional() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid review completion input" });
      const auth = req.authUser!;
      const review = await prisma.review.findFirst({ where: { id: routeParam(req.params.id), tenantId: auth.tenantId } });
      if (!review) return res.status(404).json({ error: "Review not found" });
      if (review.status !== "IN_PROGRESS") return res.status(409).json({ error: "Only in-progress reviews can be completed" });
      const result = await prisma.$transaction(async tx => {
        const completed = await tx.review.update({ where: { id: review.id }, data: { status: "COMPLETED", completedAt: new Date(), ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}) } });
        await tx.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "APPLICATION_REVIEW_COMPLETED", resourceType: "Review", resourceId: review.id } });
        return completed;
      });
      return res.json(result);
    } catch (error) { return next(error); }
  });
}
