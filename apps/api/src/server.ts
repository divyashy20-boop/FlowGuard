import express from "express";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { loginSchema } from "@flowguard/contracts";
import { env } from "./env";
import { prisma } from "./db";
import { requireAuth, requireRole } from "./security";
import { registerWorkflowRoutes } from "./workflow-routes";
import { registerApplicationRoutes } from "./application-routes";
import complianceRoutes from "./compliance-routes.js";
import { registerDocumentRoutesV3 } from "./document-routes-v3";
import { registerRegistryRoutes } from "./registry-routes";
import { registerJobRoutes } from "./job-routes";
import { registerMatchingRoutes } from "./matching-routes";
import { registerIngestionRoutes } from "./ingestion-routes";
import { registerGraphRoutes } from "./graph-routes";

const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: env.WEB_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const requestId = randomUUID();
  res.setHeader("X-Request-ID", requestId);
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "flowguard-api" });
});

app.get("/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ready", database: "connected" });
  } catch {
    res.status(503).json({ status: "not_ready", database: "unavailable" });
  }
});

app.post("/auth/login", async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid login input" });
    }

    const user = await prisma.user.findUnique({
      where: { email: parsed.data.email.toLowerCase() },
      include: { memberships: { where: { active: true } } }
    });

    if (!user || !user.active || user.memberships.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const passwordOk = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!passwordOk) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const membership = user.memberships[0];
    const token = jwt.sign({
      userId: user.id,
      tenantId: membership.tenantId,
      role: membership.role
    }, env.JWT_SECRET, { expiresIn: "2h", issuer: "flowguard-api", audience: "flowguard-web" });

    await prisma.auditEvent.create({
      data: {
        tenantId: membership.tenantId,
        actorUserId: user.id,
        action: "AUTH_LOGIN",
        resourceType: "User",
        resourceId: user.id
      }
    });

    return res.json({
      accessToken: token,
      user: { id: user.id, email: user.email, name: user.name, role: membership.role }
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/me", requireAuth, async (req, res, next) => {
  try {
    const auth = req.authUser!;
    const membership = await prisma.membership.findFirst({
      where: {
        userId: auth.userId,
        tenantId: auth.tenantId,
        active: true
      },
      include: { tenant: { select: { id: true, name: true } } }
    });

    if (!membership) return res.status(403).json({ error: "Membership unavailable" });

    return res.json({
      userId: auth.userId,
      tenant: membership.tenant,
      role: membership.role
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/dashboard/summary", requireAuth, async (req, res, next) => {
  try {
    const tenantId = req.authUser!.tenantId;
    const now = new Date();
    const expiryHorizon = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const [institutions, applications, openDeficiencies, pendingReviews, applicationStatuses, approvalsExpiringSoon, openFindingsBySeverity, documentsAwaitingProcessing, documentsAwaitingHumanReview, failedJobs, recentActivity] = await Promise.all([
      prisma.institution.count({ where: { tenantId, archivedAt: null } }),
      prisma.application.count({ where: { tenantId } }),
      prisma.deficiency.count({ where: { tenantId, status: "OPEN" } }),
      prisma.review.count({ where: { tenantId, status: { in: ["PENDING", "IN_PROGRESS"] } } }),
      prisma.application.groupBy({ by: ["status"], where: { tenantId }, _count: { _all: true } }),
      prisma.approval.count({ where: { institution: { tenantId }, validTo: { gte: now, lte: expiryHorizon } } }),
      prisma.complianceFinding.groupBy({ by: ["severity"], where: { tenantId, status: "OPEN" }, _count: { _all: true } }),
      prisma.document.count({ where: { application: { tenantId }, processingState: { in: ["QUEUED", "RUNNING"] } } }),
      prisma.document.count({ where: { application: { tenantId }, extractions: { some: { humanVerified: false } } } }),
      prisma.backgroundJob.count({ where: { tenantId, status: { in: ["RETRY", "DEAD_LETTER"] } } }),
      prisma.auditEvent.findMany({ where: { tenantId }, select: { id: true, action: true, resourceType: true, resourceId: true, createdAt: true, actor: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 8 })
    ]);
    return res.json({ institutions, applications, openDeficiencies, pendingReviews, applicationStatuses: applicationStatuses.map(item => ({ status: item.status, count: item._count._all })), approvalsExpiringSoon, openFindingsBySeverity: openFindingsBySeverity.map(item => ({ severity: item.severity, count: item._count._all })), documentsAwaitingProcessing, documentsAwaitingHumanReview, failedJobs, recentActivity });
  } catch (error) {
    return next(error);
  }
});

app.get("/institutions", requireAuth, async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
    const items = await prisma.institution.findMany({
      where: {
        tenantId: req.authUser!.tenantId,
        archivedAt: null,
        ...(q ? { OR: [
          { name: { contains: q, mode: "insensitive" } },
          { promoter: { name: { contains: q, mode: "insensitive" } } },
          { externalIds: { some: { OR: [
            { value: { contains: q, mode: "insensitive" } },
            { namespace: { contains: q, mode: "insensitive" } },
            { issuer: { contains: q, mode: "insensitive" } }
          ] } } }
        ] } : {})
      },
      select: { id: true, name: true, institutionType: true, createdAt: true, promoter: { select: { id: true, name: true, legalType: true } }, _count: { select: { campuses: true, applications: true } } },
      orderBy: { createdAt: "desc" },
      take: 100
    });
    return res.json({ items });
  } catch (error) {
    return next(error);
  }
});

app.get("/audit", requireAuth, async (req, res, next) => {
  try {
    const auth = req.authUser!;
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
    const action = typeof req.query.action === "string" ? req.query.action.trim().slice(0, 80) : "";
    const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Number(req.query.pageSize) || 50));
    const where = { tenantId: auth.tenantId, ...(action ? { action: { contains: action, mode: "insensitive" as const } } : {}), ...(q ? { OR: [{ resourceType: { contains: q, mode: "insensitive" as const } }, { resourceId: { contains: q, mode: "insensitive" as const } }, { action: { contains: q, mode: "insensitive" as const } }] } : {}) };
    const [items, total] = await Promise.all([
      prisma.auditEvent.findMany({ where, select: { id: true, action: true, resourceType: true, resourceId: true, createdAt: true, actor: { select: { name: true } } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.auditEvent.count({ where })
    ]);
    return res.json({ items, total, page, pageSize });
  } catch (error) { return next(error); }
});

app.post("/institutions", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
  try {
    const { createInstitutionSchema } = await import("@flowguard/contracts");
    const parsed = createInstitutionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid institution input" });

    const auth = req.authUser!;
    const institution = await prisma.institution.create({
      data: {
        tenantId: auth.tenantId,
        name: parsed.data.name,
        institutionType: parsed.data.institutionType,
        createdByUserId: auth.userId
      },
      select: { id: true, name: true, institutionType: true, createdAt: true }
    });

    await prisma.auditEvent.create({
      data: {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "INSTITUTION_CREATED",
        resourceType: "Institution",
        resourceId: institution.id
      }
    });

    return res.status(201).json(institution);
  } catch (error) {
    return next(error);
  }
});

registerWorkflowRoutes(app);
registerApplicationRoutes(app);
registerDocumentRoutesV3(app);
registerRegistryRoutes(app);
registerJobRoutes(app);
registerMatchingRoutes(app);
registerIngestionRoutes(app);
registerGraphRoutes(app);
app.use(complianceRoutes);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Request failed", err instanceof Error ? err.name : "UnknownError");
  res.status(500).json({ error: "Internal server error" });
});

if (require.main === module) {
  app.listen(env.PORT, () => console.log(`FlowGuard API listening on port ${env.PORT}`));
}

export { app };


