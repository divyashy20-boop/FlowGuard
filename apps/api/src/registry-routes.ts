import type { Express } from "express";
import { z } from "zod";
import { prisma } from "./db";
import { requireAuth, requireRole } from "./security";

const promoterInput = z.object({ institutionId: z.string().min(1), name: z.string().trim().min(2).max(200), legalType: z.string().trim().max(80).optional() });
const campusInput = z.object({ institutionId: z.string().min(1), name: z.string().trim().min(2).max(200), address: z.string().trim().max(1000).optional() });
const programmeInput = z.object({ name: z.string().trim().min(2).max(200), discipline: z.string().trim().max(120).optional() });
const offeringInput = z.object({ programmeId: z.string().min(1), campusId: z.string().min(1), academicYear: z.string().trim().min(4).max(20), approvedIntake: z.number().int().nonnegative().optional() });
const identifierInput = z.object({ issuer: z.string().trim().min(2).max(120), namespace: z.string().trim().min(1).max(120), value: z.string().trim().min(1).max(200), sourceReference: z.string().trim().max(500).optional(), institutionId: z.string().optional(), campusId: z.string().optional(), applicationId: z.string().optional() }).refine(v => Number(Boolean(v.institutionId)) + Number(Boolean(v.campusId)) + Number(Boolean(v.applicationId)) === 1);
const approvalInput = z.object({ institutionId: z.string().min(1), programmeName: z.string().trim().min(2).max(200), academicYear: z.string().trim().min(4).max(20), validFrom: z.string().datetime().optional(), validTo: z.string().datetime().optional(), sourceReference: z.string().trim().max(500).optional(), decisionId: z.string().optional() }).refine(v => !v.validFrom || !v.validTo || v.validFrom <= v.validTo);
const obligationInput = z.object({ institutionId: z.string().min(1), title: z.string().trim().min(2).max(300), dueAt: z.string().datetime().optional(), sourceReference: z.string().trim().max(500).optional() });
const obligationUpdate = z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "FULFILLED", "OVERDUE", "WAIVED"]) });
const inspectionInput = z.object({ scheduledAt: z.string().datetime().optional(), completedAt: z.string().datetime().optional(), outcome: z.string().trim().max(80).optional(), findings: z.string().trim().max(10000).optional() });
const evcInput = z.object({ committeeReference: z.string().trim().max(200).optional(), assessedAt: z.string().datetime().optional(), outcome: z.string().trim().max(80).optional(), findings: z.string().trim().max(10000).optional() });

export function registerRegistryRoutes(app: Express) {
  app.get("/reviews", requireAuth, async (req, res, next) => {
    try {
      const status = typeof req.query.status === "string" && ["PENDING", "IN_PROGRESS", "COMPLETED"].includes(req.query.status) ? req.query.status as "PENDING" | "IN_PROGRESS" | "COMPLETED" : undefined;
      const items = await prisma.review.findMany({ where: { tenantId: req.authUser!.tenantId, ...(status ? { status } : {}) }, include: { application: { select: { id: true, academicYear: true, status: true, institution: { select: { id: true, name: true } }, workflow: { select: { category: true, version: true } } } } }, orderBy: [{ status: "asc" }, { startedAt: "asc" }], take: 200 });
      return res.json({ items });
    } catch (error) { return next(error); }
  });
  app.get("/decisions", requireAuth, async (req, res, next) => {
    try {
      const items = await prisma.formalDecision.findMany({ where: { application: { tenantId: req.authUser!.tenantId } }, include: { application: { select: { id: true, institutionId: true, academicYear: true, programme: { select: { name: true } }, institution: { select: { id: true, name: true } } } }, approval: { select: { id: true, validFrom: true, validTo: true } } }, orderBy: { issuedAt: "desc" }, take: 200 });
      return res.json({ items });
    } catch (error) { return next(error); }
  });
  app.get("/promoters", requireAuth, async (req, res, next) => {
    try { const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : ""; return res.json({ items: await prisma.promoter.findMany({ where: { institutions: { some: { tenantId: req.authUser!.tenantId, archivedAt: null } }, ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) }, include: { institutions: { where: { tenantId: req.authUser!.tenantId, archivedAt: null }, select: { id: true, name: true, institutionType: true } } }, orderBy: { name: "asc" }, take: 200 }) }); } catch (error) { return next(error); }
  });
  app.post("/promoters", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = promoterInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid promoter input" });
      const auth = req.authUser!;
      const institution = await prisma.institution.findFirst({ where: { id: parsed.data.institutionId, tenantId: auth.tenantId, archivedAt: null }, select: { id: true } });
      if (!institution) return res.status(404).json({ error: "Institution not found" });
      const item = await prisma.$transaction(async tx => {
        const promoter = await tx.promoter.create({ data: { name: parsed.data.name, legalType: parsed.data.legalType } });
        await tx.institution.update({ where: { id: institution.id }, data: { promoterId: promoter.id } });
        return promoter;
      });
      await prisma.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "PROMOTER_CREATED", resourceType: "Promoter", resourceId: item.id } });
      return res.status(201).json(item);
    } catch (error) { return next(error); }
  });
  app.put("/institutions/:id/promoter", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const promoterId = z.object({ promoterId: z.string().min(1).nullable() }).safeParse(req.body);
      if (!promoterId.success) return res.status(400).json({ error: "Invalid promoter assignment" });
      const auth = req.authUser!;
      const institution = await prisma.institution.findFirst({ where: { id: req.params.id, tenantId: auth.tenantId, archivedAt: null }, select: { id: true } });
      if (!institution) return res.status(404).json({ error: "Institution not found" });
      if (promoterId.data.promoterId && !await prisma.promoter.findFirst({ where: { id: promoterId.data.promoterId, institutions: { some: { tenantId: auth.tenantId } } }, select: { id: true } })) return res.status(400).json({ error: "Promoter not found in this tenant" });
      const item = await prisma.institution.update({ where: { id: institution.id }, data: { promoterId: promoterId.data.promoterId } });
      await prisma.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "INSTITUTION_PROMOTER_CHANGED", resourceType: "Institution", resourceId: item.id } });
      return res.json(item);
    } catch (error) { return next(error); }
  });
  app.get("/campuses", requireAuth, async (req, res, next) => {
    try { const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : ""; return res.json({ items: await prisma.campus.findMany({ where: { institution: { tenantId: req.authUser!.tenantId, archivedAt: null }, ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { institution: { name: { contains: q, mode: "insensitive" } } }] } : {}) }, include: { institution: { select: { id: true, name: true } } }, orderBy: { name: "asc" }, take: 300 }) }); } catch (error) { return next(error); }
  });
  app.post("/campuses", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = campusInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid campus input" });
      const auth = req.authUser!;
      const institution = await prisma.institution.findFirst({ where: { id: parsed.data.institutionId, tenantId: auth.tenantId, archivedAt: null }, select: { id: true } });
      if (!institution) return res.status(404).json({ error: "Institution not found" });
      const item = await prisma.campus.create({ data: { institutionId: institution.id, name: parsed.data.name, address: parsed.data.address } });
      await prisma.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "CAMPUS_CREATED", resourceType: "Campus", resourceId: item.id } });
      return res.status(201).json(item);
    } catch (error) { return next(error); }
  });
  app.get("/programmes", requireAuth, async (req, res, next) => {
    try { const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : ""; return res.json({ items: await prisma.programme.findMany({ where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { discipline: { contains: q, mode: "insensitive" } }] } : {}, orderBy: { name: "asc" }, take: 200 }) }); } catch (error) { return next(error); }
  });
  app.post("/programmes", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = programmeInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid programme input" });
      const item = await prisma.programme.create({ data: parsed.data });
      await prisma.auditEvent.create({ data: { tenantId: req.authUser!.tenantId, actorUserId: req.authUser!.userId, action: "PROGRAMME_CREATED", resourceType: "Programme", resourceId: item.id } });
      return res.status(201).json(item);
    } catch (error) { return next(error); }
  });
  app.get("/course-offerings", requireAuth, async (req, res, next) => {
    try { return res.json({ items: await prisma.courseOffering.findMany({ where: { campus: { institution: { tenantId: req.authUser!.tenantId, archivedAt: null } } }, include: { programme: true, campus: { include: { institution: { select: { id: true, name: true } } } } }, orderBy: [{ academicYear: "desc" }, { createdAt: "desc" }], take: 300 }) }); } catch (error) { return next(error); }
  });
  app.post("/course-offerings", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = offeringInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid course offering input" });
      const campus = await prisma.campus.findFirst({ where: { id: parsed.data.campusId, institution: { tenantId: req.authUser!.tenantId, archivedAt: null } }, select: { id: true } });
      if (!campus || !await prisma.programme.findUnique({ where: { id: parsed.data.programmeId }, select: { id: true } })) return res.status(404).json({ error: "Campus or programme not found" });
      const item = await prisma.courseOffering.create({ data: parsed.data });
      await prisma.auditEvent.create({ data: { tenantId: req.authUser!.tenantId, actorUserId: req.authUser!.userId, action: "COURSE_OFFERING_CREATED", resourceType: "CourseOffering", resourceId: item.id } });
      return res.status(201).json(item);
    } catch (error) { return next(error); }
  });
  app.get("/external-identifiers", requireAuth, async (req, res, next) => {
    try { const tenantId = req.authUser!.tenantId; const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : ""; return res.json({ items: await prisma.externalIdentifier.findMany({ where: { AND: [{ OR: [{ institution: { tenantId } }, { campus: { institution: { tenantId } } }, { application: { tenantId } }] }, ...(q ? [{ OR: [{ issuer: { contains: q, mode: "insensitive" as const } }, { namespace: { contains: q, mode: "insensitive" as const } }, { value: { contains: q, mode: "insensitive" as const } }] }] : [])] }, include: { institution: { select: { id: true, name: true } }, campus: { select: { id: true, name: true } }, application: { select: { id: true, applicationNumber: true } } }, orderBy: { createdAt: "desc" }, take: 200 }) }); } catch (error) { return next(error); }
  });
  app.post("/external-identifiers", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = identifierInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Provide one tenant-owned target and valid identifier fields" });
      const auth = req.authUser!; const data = parsed.data;
      if (data.institutionId && !await prisma.institution.findFirst({ where: { id: data.institutionId, tenantId: auth.tenantId }, select: { id: true } })) return res.status(404).json({ error: "Institution not found" });
      if (data.campusId && !await prisma.campus.findFirst({ where: { id: data.campusId, institution: { tenantId: auth.tenantId } }, select: { id: true } })) return res.status(404).json({ error: "Campus not found" });
      if (data.applicationId && !await prisma.application.findFirst({ where: { id: data.applicationId, tenantId: auth.tenantId }, select: { id: true } })) return res.status(404).json({ error: "Application not found" });
      const item = await prisma.externalIdentifier.create({ data });
      await prisma.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "EXTERNAL_IDENTIFIER_RECORDED", resourceType: "ExternalIdentifier", resourceId: item.id } });
      return res.status(201).json(item);
    } catch (error) { return next(error); }
  });
  app.get("/approvals", requireAuth, async (req, res, next) => {
    try { const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : ""; return res.json({ items: await prisma.approval.findMany({ where: { institution: { tenantId: req.authUser!.tenantId, ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) } }, include: { institution: { select: { id: true, name: true } }, decision: { select: { id: true, outcome: true, issuedAt: true, reference: true, letterStorageKey: true } } }, orderBy: { createdAt: "desc" }, take: 200 }) }); } catch (error) { return next(error); }
  });
  app.post("/approvals", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = approvalInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid approval input" });
      const auth = req.authUser!; const data = parsed.data;
      const institution = await prisma.institution.findFirst({ where: { id: data.institutionId, tenantId: auth.tenantId }, select: { id: true } });
      if (!institution) return res.status(404).json({ error: "Institution not found" });
      if (data.decisionId && !await prisma.formalDecision.findFirst({ where: { id: data.decisionId, outcome: "APPROVED", application: { tenantId: auth.tenantId, institutionId: institution.id } }, select: { id: true } })) return res.status(400).json({ error: "Approval must reference an approved decision for this institution" });
      const item = await prisma.approval.create({ data: { ...data, validFrom: data.validFrom ? new Date(data.validFrom) : null, validTo: data.validTo ? new Date(data.validTo) : null } });
      await prisma.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "APPROVAL_RECORDED", resourceType: "Approval", resourceId: item.id } });
      return res.status(201).json(item);
    } catch (error) { return next(error); }
  });
  app.get("/obligations", requireAuth, async (req, res, next) => {
    try { const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : ""; return res.json({ items: await prisma.obligation.findMany({ where: { institution: { tenantId: req.authUser!.tenantId, ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) }, ...(typeof req.query.status === "string" && ["OPEN", "IN_PROGRESS", "FULFILLED", "OVERDUE", "WAIVED"].includes(req.query.status) ? { status: req.query.status as "OPEN" | "IN_PROGRESS" | "FULFILLED" | "OVERDUE" | "WAIVED" } : {}) }, include: { institution: { select: { id: true, name: true } } }, orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }], take: 200 }) }); } catch (error) { return next(error); }
  });
  app.post("/obligations", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = obligationInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid obligation input" });
      const auth = req.authUser!; const institution = await prisma.institution.findFirst({ where: { id: parsed.data.institutionId, tenantId: auth.tenantId }, select: { id: true } });
      if (!institution) return res.status(404).json({ error: "Institution not found" });
      const item = await prisma.obligation.create({ data: { ...parsed.data, dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : null } });
      await prisma.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "OBLIGATION_CREATED", resourceType: "Obligation", resourceId: item.id } });
      return res.status(201).json(item);
    } catch (error) { return next(error); }
  });
  app.patch("/obligations/:id", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = obligationUpdate.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid obligation status" });
      const auth = req.authUser!; const exists = await prisma.obligation.findFirst({ where: { id: req.params.id, institution: { tenantId: auth.tenantId } }, select: { id: true } });
      if (!exists) return res.status(404).json({ error: "Obligation not found" });
      const item = await prisma.obligation.update({ where: { id: exists.id }, data: parsed.data });
      await prisma.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "OBLIGATION_STATUS_CHANGED", resourceType: "Obligation", resourceId: item.id, metadata: { status: item.status } } });
      return res.json(item);
    } catch (error) { return next(error); }
  });
  app.get("/applications/:id/inspections", requireAuth, async (req, res, next) => {
    try {
      const application = await prisma.application.findFirst({ where: { id: req.params.id, tenantId: req.authUser!.tenantId }, select: { id: true } });
      if (!application) return res.status(404).json({ error: "Application not found" });
      return res.json({ items: await prisma.inspection.findMany({ where: { applicationId: application.id, tenantId: req.authUser!.tenantId }, orderBy: { createdAt: "desc" } }) });
    } catch (error) { return next(error); }
  });
  app.post("/applications/:id/inspections", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = inspectionInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid inspection input" });
      const auth = req.authUser!; const application = await prisma.application.findFirst({ where: { id: req.params.id, tenantId: auth.tenantId }, select: { id: true } });
      if (!application) return res.status(404).json({ error: "Application not found" });
      const item = await prisma.inspection.create({ data: { ...parsed.data, scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null, completedAt: parsed.data.completedAt ? new Date(parsed.data.completedAt) : null, tenantId: auth.tenantId, applicationId: application.id, createdByUserId: auth.userId } });
      await prisma.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "INSPECTION_RECORDED", resourceType: "Inspection", resourceId: item.id } });
      return res.status(201).json(item);
    } catch (error) { return next(error); }
  });
  app.get("/applications/:id/evc-assessments", requireAuth, async (req, res, next) => {
    try {
      const application = await prisma.application.findFirst({ where: { id: req.params.id, tenantId: req.authUser!.tenantId }, select: { id: true } });
      if (!application) return res.status(404).json({ error: "Application not found" });
      return res.json({ items: await prisma.evcAssessment.findMany({ where: { applicationId: application.id, tenantId: req.authUser!.tenantId }, orderBy: { createdAt: "desc" } }) });
    } catch (error) { return next(error); }
  });
  app.post("/applications/:id/evc-assessments", requireAuth, requireRole("ADMIN", "REVIEWER"), async (req, res, next) => {
    try {
      const parsed = evcInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid EVC assessment input" });
      const auth = req.authUser!; const application = await prisma.application.findFirst({ where: { id: req.params.id, tenantId: auth.tenantId }, select: { id: true } });
      if (!application) return res.status(404).json({ error: "Application not found" });
      const item = await prisma.evcAssessment.create({ data: { ...parsed.data, assessedAt: parsed.data.assessedAt ? new Date(parsed.data.assessedAt) : null, tenantId: auth.tenantId, applicationId: application.id, createdByUserId: auth.userId } });
      await prisma.auditEvent.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: "EVC_ASSESSMENT_RECORDED", resourceType: "EVCAssessment", resourceId: item.id } });
      return res.status(201).json(item);
    } catch (error) { return next(error); }
  });
}
