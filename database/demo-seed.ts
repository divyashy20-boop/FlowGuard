import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });
import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { localDocumentStorage } from "../apps/api/src/document-storage";
import { enqueueJobEvent } from "../apps/api/src/job-service";

const prisma = new PrismaClient();
const TENANT = "flowguard-demo-tenant";
const ADMIN_EMAIL = "admin@flowguard.local";
const DEMO_WARNING = ["Fictional demo extraction fixture; no OCR or malware scan was performed by seeding."];

function makePdf(registration: string) {
  const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT\n/F1 12 Tf\n50 740 Td\n(${escape("Institution Name: Northstar Demonstration Institute")}) Tj\n0 -20 Td\n(${escape(`Registration Number: ${registration}`)}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf, "ascii")); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

async function ensureDemoDocument(input: { id: string; name: string; applicationId: string; userId: string; registration: string }) {
  const existing = await prisma.document.findUnique({ where: { id: input.id } });
  if (existing) return existing;
  const bytes = makePdf(input.registration);
  const storageKey = await localDocumentStorage.put(bytes);
  return prisma.document.create({ data: {
    id: input.id, applicationId: input.applicationId, storageKey, originalName: input.name, mimeType: "application/pdf",
    checksumSha256: createHash("sha256").update(bytes).digest("hex"), version: 1, status: "QUARANTINED",
    processingState: "SUCCEEDED", scanResult: "NOT_CONFIGURED", processingWarnings: DEMO_WARNING as Prisma.InputJsonValue,
    processingAttempts: 0, uploadedByUserId: input.userId
  } });
}

async function main() {
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 16) throw new Error("Set SEED_ADMIN_PASSWORD (16+ characters) before seeding.");
  const tenant = await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: "FlowGuard Demo Workspace" } });
  const user = await prisma.user.upsert({ where: { email: ADMIN_EMAIL }, update: { name: "FlowGuard Admin" }, create: { email: ADMIN_EMAIL, name: "FlowGuard Admin", passwordHash: await bcrypt.hash(password, 12) } });
  await prisma.membership.upsert({ where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } }, update: { role: "ADMIN", active: true }, create: { userId: user.id, tenantId: tenant.id, role: "ADMIN" } });

  await prisma.promoter.upsert({ where: { id: "demo-promoter-northstar" }, update: { name: "Northstar Learning Trust", legalType: "Public charitable trust (fictional)" }, create: { id: "demo-promoter-northstar", name: "Northstar Learning Trust", legalType: "Public charitable trust (fictional)" } });
  const institutionA = await prisma.institution.upsert({ where: { id: "demo-institution-northstar" }, update: { name: "Northstar Demonstration Institute", institutionType: "ENGINEERING", promoterId: "demo-promoter-northstar" }, create: { id: "demo-institution-northstar", tenantId: tenant.id, name: "Northstar Demonstration Institute", institutionType: "ENGINEERING", promoterId: "demo-promoter-northstar", createdByUserId: user.id } });
  const institutionB = await prisma.institution.upsert({ where: { id: "demo-institution-northstar-annex" }, update: { name: "Northstar Demonstration Annex", institutionType: "ENGINEERING", promoterId: "demo-promoter-northstar" }, create: { id: "demo-institution-northstar-annex", tenantId: tenant.id, name: "Northstar Demonstration Annex", institutionType: "ENGINEERING", promoterId: "demo-promoter-northstar", createdByUserId: user.id } });
  const campusA = await prisma.campus.upsert({ where: { id: "demo-campus-northstar-main" }, update: { institutionId: institutionA.id, name: "Northstar Main Campus", address: "Fictional Demo District" }, create: { id: "demo-campus-northstar-main", institutionId: institutionA.id, name: "Northstar Main Campus", address: "Fictional Demo District" } });
  const campusB = await prisma.campus.upsert({ where: { id: "demo-campus-northstar-annex" }, update: { institutionId: institutionB.id, name: "Northstar Annex Campus", address: "Fictional Demo District" }, create: { id: "demo-campus-northstar-annex", institutionId: institutionB.id, name: "Northstar Annex Campus", address: "Fictional Demo District" } });
  const programme = await prisma.programme.upsert({ where: { id: "demo-programme-computing" }, update: { name: "B.Tech Computer Engineering", discipline: "Computer Engineering" }, create: { id: "demo-programme-computing", name: "B.Tech Computer Engineering", discipline: "Computer Engineering" } });
  await prisma.courseOffering.upsert({ where: { programmeId_campusId_academicYear: { programmeId: programme.id, campusId: campusA.id, academicYear: "2026-27" } }, update: { approvedIntake: 60 }, create: { programmeId: programme.id, campusId: campusA.id, academicYear: "2026-27", approvedIntake: 60 } });
  await prisma.courseOffering.upsert({ where: { programmeId_campusId_academicYear: { programmeId: programme.id, campusId: campusB.id, academicYear: "2026-27" } }, update: { approvedIntake: 45 }, create: { programmeId: programme.id, campusId: campusB.id, academicYear: "2026-27", approvedIntake: 45 } });

  const workflow1 = await prisma.workflowDefinition.upsert({ where: { category_version: { category: "NEW_INSTITUTION", version: 1 } }, update: { active: false, config: { requiredFieldsByRequirement: { LEGAL_EVIDENCE: ["registration_number"] } } }, create: { id: "demo-workflow-new-v1", category: "NEW_INSTITUTION", version: 1, active: false, config: { requiredFieldsByRequirement: { LEGAL_EVIDENCE: ["registration_number"] } } } });
  const workflow2 = await prisma.workflowDefinition.upsert({ where: { category_version: { category: "NEW_INSTITUTION", version: 2 } }, update: { active: true, config: { requiredFieldsByRequirement: { LEGAL_EVIDENCE: ["registration_number"] } } }, create: { id: "demo-workflow-new-v2", category: "NEW_INSTITUTION", version: 2, active: true, config: { requiredFieldsByRequirement: { LEGAL_EVIDENCE: ["registration_number"] } } } });
  const workflowExisting = await prisma.workflowDefinition.upsert({ where: { category_version: { category: "EXISTING_INSTITUTION", version: 1 } }, update: { active: true, config: {} }, create: { id: "demo-workflow-existing-v1", category: "EXISTING_INSTITUTION", version: 1, active: true, config: {} } });
  const req1 = await prisma.requirement.upsert({ where: { workflowId_code: { workflowId: workflow1.id, code: "LEGAL_EVIDENCE" } }, update: { description: "Fictional legal registration evidence", mandatory: true }, create: { workflowId: workflow1.id, code: "LEGAL_EVIDENCE", description: "Fictional legal registration evidence", mandatory: true } });
  const reqExisting = await prisma.requirement.upsert({ where: { workflowId_code: { workflowId: workflowExisting.id, code: "GOVERNANCE_RECORD" } }, update: { description: "Fictional governance record", mandatory: true }, create: { workflowId: workflowExisting.id, code: "GOVERNANCE_RECORD", description: "Fictional governance record", mandatory: true } });
  await prisma.requirement.upsert({ where: { workflowId_code: { workflowId: workflow2.id, code: "LEGAL_EVIDENCE" } }, update: { description: "Fictional legal registration evidence", mandatory: true }, create: { workflowId: workflow2.id, code: "LEGAL_EVIDENCE", description: "Fictional legal registration evidence", mandatory: true } });

  const approvedApp = await prisma.application.upsert({ where: { id: "demo-application-approved" }, update: { tenantId: tenant.id, institutionId: institutionA.id, campusId: campusA.id, programmeId: programme.id, workflowId: workflow1.id, academicYear: "2026-27", status: "DECISION_ISSUED" }, create: { id: "demo-application-approved", tenantId: tenant.id, institutionId: institutionA.id, campusId: campusA.id, programmeId: programme.id, workflowId: workflow1.id, academicYear: "2026-27", status: "DECISION_ISSUED", submittedAt: new Date("2026-04-10T09:00:00Z") } });
  const reviewApp = await prisma.application.upsert({ where: { id: "demo-application-review" }, update: { tenantId: tenant.id, institutionId: institutionB.id, campusId: campusB.id, programmeId: programme.id, workflowId: workflowExisting.id, academicYear: "2026-27", status: "DEFICIENCY_RAISED" }, create: { id: "demo-application-review", tenantId: tenant.id, institutionId: institutionB.id, campusId: campusB.id, programmeId: programme.id, workflowId: workflowExisting.id, academicYear: "2026-27", status: "DEFICIENCY_RAISED", submittedAt: new Date("2026-08-01T09:00:00Z") } });
  await prisma.application.upsert({ where: { id: "demo-application-draft" }, update: { tenantId: tenant.id, institutionId: institutionA.id, campusId: campusA.id, programmeId: programme.id, workflowId: workflow2.id, academicYear: "2027-28", status: "DRAFT" }, create: { id: "demo-application-draft", tenantId: tenant.id, institutionId: institutionA.id, campusId: campusA.id, programmeId: programme.id, workflowId: workflow2.id, academicYear: "2027-28", status: "DRAFT" } });

  await prisma.deficiency.upsert({ where: { id: "demo-deficiency-closed" }, update: { status: "CLOSED", closedAt: new Date("2026-05-02T09:00:00Z") }, create: { id: "demo-deficiency-closed", tenantId: tenant.id, applicationId: approvedApp.id, code: "DEMO_RESPONSE", description: "Fictional closed response cycle for demonstration.", status: "CLOSED", raisedAt: new Date("2026-04-20T09:00:00Z"), closedAt: new Date("2026-05-02T09:00:00Z") } });
  await prisma.deficiency.upsert({ where: { id: "demo-deficiency-open" }, update: { status: "RESPONSE_SUBMITTED" }, create: { id: "demo-deficiency-open", tenantId: tenant.id, applicationId: reviewApp.id, code: "DEMO_CLARIFICATION", description: "Fictional clarification response awaiting reviewer assessment.", status: "RESPONSE_SUBMITTED" } });
  await prisma.review.upsert({ where: { id: "demo-review-in-progress" }, update: { status: "IN_PROGRESS", reviewerId: user.id }, create: { id: "demo-review-in-progress", tenantId: tenant.id, applicationId: reviewApp.id, reviewerId: user.id, status: "IN_PROGRESS", startedAt: new Date("2026-09-01T09:00:00Z"), notes: "Synthetic demo review." } });
  await prisma.inspection.upsert({ where: { id: "demo-inspection-record" }, update: { outcome: "SCHEDULED" }, create: { id: "demo-inspection-record", tenantId: tenant.id, applicationId: approvedApp.id, scheduledAt: new Date("2026-11-15T09:00:00Z"), outcome: "SCHEDULED", findings: "Fictional inspection record.", createdByUserId: user.id } });
  await prisma.evcAssessment.upsert({ where: { id: "demo-evc-record" }, update: { outcome: "RECORDED" }, create: { id: "demo-evc-record", tenantId: tenant.id, applicationId: approvedApp.id, committeeReference: "SYNTH-EVC-001", assessedAt: new Date("2026-06-15T09:00:00Z"), outcome: "RECORDED", findings: "Fictional EVC assessment record.", createdByUserId: user.id } });
  const decision = await prisma.formalDecision.upsert({ where: { id: "demo-decision-approved" }, update: { applicationId: approvedApp.id, outcome: "APPROVED", authority: "Fictional Demo Authority" }, create: { id: "demo-decision-approved", applicationId: approvedApp.id, outcome: "APPROVED", issuedAt: new Date("2026-06-01T09:00:00Z"), authority: "Fictional Demo Authority", reference: "SYNTH-DECISION-001" } });
  await prisma.approval.upsert({ where: { id: "demo-approval-valid" }, update: { institutionId: institutionA.id, decisionId: decision.id, validTo: new Date("2027-06-30T00:00:00Z") }, create: { id: "demo-approval-valid", institutionId: institutionA.id, decisionId: decision.id, programmeName: programme.name, academicYear: "2026-27", validFrom: new Date("2026-07-01T00:00:00Z"), validTo: new Date("2027-06-30T00:00:00Z"), sourceReference: "Fictional demo source" } });
  await prisma.obligation.upsert({ where: { id: "demo-obligation-annual-report" }, update: { status: "OPEN", dueAt: new Date("2027-03-31T00:00:00Z") }, create: { id: "demo-obligation-annual-report", institutionId: institutionA.id, title: "Fictional annual report submission", dueAt: new Date("2027-03-31T00:00:00Z"), sourceReference: "Synthetic demonstration only" } });

  const docA = await ensureDemoDocument({ id: "demo-document-proof-a", name: "Synthetic registration proof A.pdf", applicationId: approvedApp.id, userId: user.id, registration: "SYNTH-NORTH-001" });
  const docB = await ensureDemoDocument({ id: "demo-document-proof-b", name: "Synthetic registration proof B.pdf", applicationId: approvedApp.id, userId: user.id, registration: "SYNTH-NORTH-009" });
  await prisma.evidenceExtraction.upsert({ where: { id: "demo-extraction-registration-a" }, update: {}, create: { id: "demo-extraction-registration-a", documentId: docA.id, fieldName: "registration_number", extractedValue: "SYNTH-NORTH-001", confidence: 0.5, confidenceBasis: "SYNTHETIC_DEMO_FIXTURE", sourceText: "Registration Number: SYNTH-NORTH-001", pageNumber: 1, extractor: "SYNTHETIC_DEMO", extractorVersion: "demo-v1" } });
  await prisma.evidenceExtraction.upsert({ where: { id: "demo-extraction-registration-b" }, update: {}, create: { id: "demo-extraction-registration-b", documentId: docB.id, fieldName: "registration_number", extractedValue: "SYNTH-NORTH-009", confidence: 0.5, confidenceBasis: "SYNTHETIC_DEMO_FIXTURE", sourceText: "Registration Number: SYNTH-NORTH-009", pageNumber: 1, extractor: "SYNTHETIC_DEMO", extractorVersion: "demo-v1" } });
  await prisma.requirementEvidence.upsert({ where: { requirementId_documentId: { requirementId: req1.id, documentId: docA.id } }, update: {}, create: { requirementId: req1.id, documentId: docA.id, linkedByUserId: user.id } });
  await prisma.requirementEvidence.upsert({ where: { requirementId_documentId: { requirementId: req1.id, documentId: docB.id } }, update: {}, create: { requirementId: req1.id, documentId: docB.id, linkedByUserId: user.id } });
  await prisma.requirementEvidence.upsert({ where: { requirementId_documentId: { requirementId: reqExisting.id, documentId: docA.id } }, update: {}, create: { requirementId: reqExisting.id, documentId: docA.id, linkedByUserId: user.id } });

  const matchKey = { leftApplicationId: approvedApp.id, rightApplicationId: reviewApp.id };
  await prisma.matchCandidate.upsert({ where: { leftApplicationId_rightApplicationId: matchKey }, update: { tenantId: tenant.id, score: 0.72, reasons: [{ field: "promoter", signal: "shared_promoter" }], evidenceReferences: [{ applicationId: approvedApp.id }, { applicationId: reviewApp.id }], reviewStatus: "SUGGESTED" }, create: { tenantId: tenant.id, ...matchKey, score: 0.72, reasons: [{ field: "promoter", signal: "shared_promoter" }], evidenceReferences: [{ applicationId: approvedApp.id }, { applicationId: reviewApp.id }] } });
  await prisma.complianceAnalysis.upsert({ where: { applicationId: approvedApp.id }, update: { tenantId: tenant.id, readinessEstimate: 60, ruleVersion: "demo-seed-v1", summary: { note: "Synthetic demonstration estimate only." } }, create: { tenantId: tenant.id, applicationId: approvedApp.id, readinessEstimate: 60, ruleVersion: "demo-seed-v1", summary: { note: "Synthetic demonstration estimate only." } } });
  const refs = [{ documentId: docA.id, version: 1, extractionId: "demo-extraction-registration-a", pageNumber: 1, sourceText: "Registration Number: SYNTH-NORTH-001" }, { documentId: docB.id, version: 1, extractionId: "demo-extraction-registration-b", pageNumber: 1, sourceText: "Registration Number: SYNTH-NORTH-009" }];
  const conflictKey = createHash("sha256").update("demo|conflicting-registration|northstar").digest("hex");
  await prisma.complianceFinding.upsert({ where: { dedupeKey: conflictKey }, update: { evidenceReferences: refs, status: "OPEN" }, create: { tenantId: tenant.id, applicationId: approvedApp.id, requirementId: req1.id, dedupeKey: conflictKey, code: "CONFLICTING_FIELD_VALUES", severity: "WARNING", title: "Synthetic registration values differ", explanation: "The two fictional documents contain different registration values. Compare each cited source before resolving this demonstration finding.", evidenceReferences: refs, ruleVersion: "demo-seed-v1" } });

  const batch = await prisma.ingestionBatch.upsert({ where: { idempotencyKey: `${tenant.id}:part4-demo-fixture` }, update: { status: "COMPLETED", sourceChecksum: createHash("sha256").update("synthetic-fixture-v1").digest("hex"), totalRecords: 2, stagedRecords: 2 }, create: { id: "demo-import-batch", tenantId: tenant.id, createdByUserId: user.id, sourceName: "Synthetic Northstar fixture", sourceType: "SYNTHETIC_DEMO_FIXTURE", sourceReference: "Fictional demo records", sourceChecksum: createHash("sha256").update("synthetic-fixture-v1").digest("hex"), idempotencyKey: `${tenant.id}:part4-demo-fixture`, status: "COMPLETED", totalRecords: 2, stagedRecords: 2, completedAt: new Date() } });
  const batchRows = [{ sourceRecordKey: "DEMO-NORTH-A", name: institutionA.name, institutionType: "ENGINEERING", promoterName: "Northstar Learning Trust" }, { sourceRecordKey: "DEMO-NORTH-B", name: institutionB.name, institutionType: "ENGINEERING", promoterName: "Northstar Learning Trust" }];
  for (const record of batchRows) await prisma.ingestionRecord.upsert({ where: { batchId_sourceRecordKey: { batchId: batch.id, sourceRecordKey: record.sourceRecordKey } }, update: {}, create: { batchId: batch.id, sourceRecordKey: record.sourceRecordKey, normalizedData: record, status: "NEEDS_REVIEW", candidateInstitutionId: record.sourceRecordKey.endsWith("A") ? institutionA.id : institutionB.id, candidateScore: 1, matchReasons: [{ signal: "synthetic_exact_name_fixture" }] } });
  await prisma.ingestionBatch.update({ where: { id: batch.id }, data: { stagedRecords: 2 } });

  await prisma.backgroundJob.upsert({ where: { idempotencyKey: `${tenant.id}:part4-demo-job-history` }, update: {}, create: { id: "demo-job-history", tenantId: tenant.id, type: "ANALYZE_COMPLIANCE", status: "COMPLETED", idempotencyKey: `${tenant.id}:part4-demo-job-history`, payload: { applicationId: approvedApp.id, demo: true }, attempts: 1, progress: 100, progressMessage: "Synthetic demonstration job history; not executed by the worker.", completedAt: new Date("2026-10-01T12:00:00Z") } });
  await prisma.auditEvent.upsert({ where: { id: "demo-audit-seed" }, update: {}, create: { id: "demo-audit-seed", tenantId: tenant.id, actorUserId: user.id, action: "SYNTHETIC_DEMO_DATA_SEEDED", resourceType: "Tenant", resourceId: tenant.id, metadata: { fictional: true } } });

  for (const doc of [docA, docB]) {
    await prisma.$transaction(tx => enqueueJobEvent(tx, { tenantId: tenant.id, type: "ANALYZE_COMPLIANCE", aggregateType: "Application", aggregateId: approvedApp.id, payload: { applicationId: approvedApp.id, requestedByUserId: user.id }, idempotencyKey: `part4-demo-analysis:${doc.id}` }));
  }
  console.log(`Seeded repeatable fictional SIH demo records for ${ADMIN_EMAIL}. Synthetic PDFs are quarantined because no malware scanner is configured.`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Demo seed failed"); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
