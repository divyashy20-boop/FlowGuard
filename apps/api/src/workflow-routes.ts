import type { Express } from "express";
import { z } from "zod";
import { prisma } from "./db";
import { requireAuth, requireRole } from "./security";


function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
const workflowSchema = z.object({
  category: z.string().trim().min(2).max(80).regex(/^[A-Z][A-Z0-9_]*$/),
  version: z.number().int().positive(),
  config: z.record(z.string(), z.unknown()),
  active: z.boolean().optional().default(false)
});

const requirementSchema = z.object({
  code: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  description: z.string().trim().min(3).max(2000),
  mandatory: z.boolean().optional().default(true)
});

export function registerWorkflowRoutes(app: Express) {
  app.get("/workflows", requireAuth, async (req, res, next) => {
    try {
      const includeInactive = ["ADMIN", "REVIEWER"].includes(req.authUser!.role);
      const workflows = await prisma.workflowDefinition.findMany({
        where: includeInactive ? {} : { active: true },
        include: {
          requirements: {
            select: { id: true, code: true, description: true, mandatory: true }
          }
        },
        orderBy: [{ category: "asc" }, { version: "desc" }]
      });
      return res.json({ items: workflows });
    } catch (error) {
      return next(error);
    }
  });

  app.post(
    "/workflows",
    requireAuth,
    requireRole("ADMIN", "REVIEWER"),
    async (req, res, next) => {
      try {
        const parsed = workflowSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid workflow input" });
        }

        const { category, version, config, active } = parsed.data;
        const existing = await prisma.workflowDefinition.findUnique({
          where: { category_version: { category, version } }
        });

        if (existing) {
          return res.status(409).json({
            error: "This workflow category and version already exist"
          });
        }

        const workflow = await prisma.$transaction(async (tx) => {
          if (active) {
            await tx.workflowDefinition.updateMany({
              where: { category, active: true },
              data: { active: false }
            });
          }

          return tx.workflowDefinition.create({
            data: {
              category,
              version,
              config: config as import("@prisma/client").Prisma.InputJsonValue,
              active
            },
            include: {
              requirements: true
            }
          });
        });

        await prisma.auditEvent.create({
          data: {
            tenantId: req.authUser!.tenantId,
            actorUserId: req.authUser!.userId,
            action: "WORKFLOW_VERSION_CREATED",
            resourceType: "WorkflowDefinition",
            resourceId: workflow.id
          }
        });

        return res.status(201).json(workflow);
      } catch (error) {
        return next(error);
      }
    }
  );

  app.get("/workflows/:workflowId/requirements", requireAuth, async (req, res, next) => {
    try {
      const workflow = await prisma.workflowDefinition.findUnique({
        where: { id: routeParam(req.params.workflowId) },
        select: { id: true }
      });

      if (!workflow) return res.status(404).json({ error: "Workflow not found" });

      const items = await prisma.requirement.findMany({
        where: { workflowId: workflow.id },
        orderBy: { code: "asc" }
      });

      return res.json({ items });
    } catch (error) {
      return next(error);
    }
  });

  app.post(
    "/workflows/:workflowId/requirements",
    requireAuth,
    requireRole("ADMIN", "REVIEWER"),
    async (req, res, next) => {
      try {
        const parsed = requirementSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid requirement input" });
        }

        const workflow = await prisma.workflowDefinition.findUnique({
          where: { id: routeParam(req.params.workflowId) },
          select: { id: true, _count: { select: { applications: true } } }
        });

        if (!workflow) return res.status(404).json({ error: "Workflow not found" });
        if (workflow._count.applications > 0) return res.status(409).json({ error: "Workflow requirements are frozen after the version is used; create a new workflow version" });

        const duplicate = await prisma.requirement.findUnique({
          where: {
            workflowId_code: {
              workflowId: workflow.id,
              code: parsed.data.code
            }
          }
        });

        if (duplicate) {
          return res.status(409).json({ error: "Requirement code already exists" });
        }

        const requirement = await prisma.requirement.create({
          data: {
            workflowId: workflow.id,
            code: parsed.data.code,
            description: parsed.data.description,
            mandatory: parsed.data.mandatory
          }
        });

        await prisma.auditEvent.create({
          data: {
            tenantId: req.authUser!.tenantId,
            actorUserId: req.authUser!.userId,
            action: "WORKFLOW_REQUIREMENT_CREATED",
            resourceType: "Requirement",
            resourceId: requirement.id
          }
        });

        return res.status(201).json(requirement);
      } catch (error) {
        return next(error);
      }
    }
  );
}
