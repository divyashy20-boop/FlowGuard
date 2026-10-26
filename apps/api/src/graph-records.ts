import { prisma } from "./db";

export async function findAuthoritativeGraphRecord(tenantId: string, sourceTable: string, sourceId: string): Promise<Record<string, unknown> | null | undefined> {
  switch (sourceTable) {
    case "Promoter": return prisma.promoter.findFirst({ where: { id: sourceId, institutions: { some: { tenantId } } }, select: { id: true, name: true, legalType: true, createdAt: true } });
    case "Institution": return prisma.institution.findFirst({ where: { id: sourceId, tenantId }, select: { id: true, name: true, institutionType: true, archivedAt: true, createdAt: true } });
    case "Campus": return prisma.campus.findFirst({ where: { id: sourceId, institution: { tenantId } }, select: { id: true, name: true, institutionId: true, createdAt: true } });
    case "Programme": return prisma.programme.findFirst({ where: { id: sourceId, OR: [{ offerings: { some: { campus: { institution: { tenantId } } } } }, { applications: { some: { tenantId } } }] }, select: { id: true, name: true, discipline: true, createdAt: true } });
    case "CourseOffering": return prisma.courseOffering.findFirst({ where: { id: sourceId, campus: { institution: { tenantId } } }, select: { id: true, programmeId: true, campusId: true, academicYear: true, approvedIntake: true, createdAt: true } });
    case "Application": return prisma.application.findFirst({ where: { id: sourceId, tenantId }, select: { id: true, institutionId: true, campusId: true, programmeId: true, applicationNumber: true, status: true, academicYear: true, createdAt: true, updatedAt: true } });
    case "WorkflowDefinition": return prisma.workflowDefinition.findFirst({ where: { id: sourceId, applications: { some: { tenantId } } }, select: { id: true, category: true, version: true, active: true } });
    case "Requirement": return prisma.requirement.findFirst({ where: { id: sourceId, workflow: { applications: { some: { tenantId } } } }, select: { id: true, workflowId: true, code: true, mandatory: true } });
    case "Document": return prisma.document.findFirst({ where: { id: sourceId, application: { tenantId } }, select: { id: true, applicationId: true, version: true, status: true, processingState: true, scanResult: true, mimeType: true, uploadedAt: true, updatedAt: true } });
    case "EvidenceExtraction": return prisma.evidenceExtraction.findFirst({ where: { id: sourceId, document: { application: { tenantId } } }, select: { id: true, documentId: true, fieldName: true, confidence: true, pageNumber: true, humanVerified: true, verifiedAt: true, extractor: true, extractorVersion: true, confidenceBasis: true } });
    case "Deficiency": return prisma.deficiency.findFirst({ where: { id: sourceId, tenantId }, select: { id: true, applicationId: true, code: true, status: true, raisedAt: true, responseSubmittedAt: true, closedAt: true } });
    case "Review": return prisma.review.findFirst({ where: { id: sourceId, tenantId }, select: { id: true, applicationId: true, status: true, startedAt: true, completedAt: true } });
    case "Inspection": return prisma.inspection.findFirst({ where: { id: sourceId, tenantId }, select: { id: true, applicationId: true, outcome: true, scheduledAt: true, completedAt: true, createdAt: true } });
    case "EvcAssessment": return prisma.evcAssessment.findFirst({ where: { id: sourceId, tenantId }, select: { id: true, applicationId: true, outcome: true, committeeReference: true, assessedAt: true, createdAt: true } });
    case "FormalDecision": return prisma.formalDecision.findFirst({ where: { id: sourceId, application: { tenantId } }, select: { id: true, applicationId: true, outcome: true, issuedAt: true, authority: true } });
    case "Approval": return prisma.approval.findFirst({ where: { id: sourceId, institution: { tenantId } }, select: { id: true, institutionId: true, decisionId: true, programmeName: true, academicYear: true, validFrom: true, validTo: true, verifiedAt: true } });
    case "Obligation": return prisma.obligation.findFirst({ where: { id: sourceId, institution: { tenantId } }, select: { id: true, institutionId: true, title: true, dueAt: true, status: true } });
    case "ExternalIdentifier": return prisma.externalIdentifier.findFirst({ where: { id: sourceId, OR: [{ institution: { tenantId } }, { campus: { institution: { tenantId } } }, { application: { tenantId } }] }, select: { id: true, issuer: true, namespace: true, value: true, sourceReference: true, verifiedAt: true, institutionId: true, campusId: true, applicationId: true } });
    default: return undefined;
  }
}
