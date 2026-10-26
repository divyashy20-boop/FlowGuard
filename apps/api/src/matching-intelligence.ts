import { prisma } from "./db";
import { createHash } from "node:crypto";

export function normalize(value: unknown) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function similarity(leftValue: string, rightValue: string) {
  const left = normalize(leftValue);
  const right = normalize(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const matrix = Array.from({ length: left.length + 1 }, (_, i) => Array.from({ length: right.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= left.length; i += 1) for (let j = 1; j <= right.length; j += 1) matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
  return 1 - matrix[left.length][right.length] / Math.max(left.length, right.length);
}

export async function matchApplication(tenantId: string, applicationId: string) {
  const current = await prisma.application.findFirst({ where: { id: applicationId, tenantId }, include: { institution: { include: { promoter: true } }, documents: { include: { extractions: { where: { humanVerified: true } } } } } });
  if (!current) throw new Error("Application is not available in this tenant.");
  const candidates = await prisma.application.findMany({ where: { tenantId, id: { not: current.id }, institutionId: { not: current.institutionId } }, include: { institution: { include: { promoter: true } }, documents: { include: { extractions: { where: { humanVerified: true } } } } }, take: 200 });
  let count = 0;
  const candidateKeys: string[] = [];
  for (const candidate of candidates) {
    const [leftApplicationId, rightApplicationId] = [current.id, candidate.id].sort();
    const left = current.id === leftApplicationId ? current : candidate;
    const right = current.id === leftApplicationId ? candidate : current;
    const nameScore = similarity(normalize(left.institution.name), normalize(right.institution.name));
    const samePromoter = Boolean(left.institution.promoterId && left.institution.promoterId === right.institution.promoterId);
    const verifiedIdentifiers = (application: typeof current) => application.documents.flatMap(document => document.extractions.filter(field => field.humanVerified && ["registration_number", "document_number"].includes(field.fieldName)).map(field => ({ documentId: document.id, version: document.version, field })));
    const leftIds = verifiedIdentifiers(left);
    const rightIds = verifiedIdentifiers(right);
    const sharedIdentifier = leftIds.flatMap(a => rightIds.filter(b => normalize(a.field.verifiedValue ?? a.field.extractedValue) === normalize(b.field.verifiedValue ?? b.field.extractedValue) && normalize(a.field.verifiedValue ?? a.field.extractedValue)).map(b => ({ left: a, right: b }))).at(0);
    const reasons: Array<Record<string, unknown>> = [];
    const refs: Array<Record<string, unknown>> = [];
    if (nameScore >= 0.68) {
      reasons.push({ field: "institution_name", signal: "normalized_edit_similarity", score: Number(nameScore.toFixed(3)), interpretation: "Possible textual similarity only." });
      refs.push({ leftInstitutionId: left.institutionId, rightInstitutionId: right.institutionId, leftName: left.institution.name, rightName: right.institution.name });
    }
    if (samePromoter) {
      reasons.push({ field: "promoter_id", signal: "same_linked_promoter_record", score: 0.85 });
      refs.push({ promoterId: left.institution.promoterId, leftInstitutionId: left.institutionId, rightInstitutionId: right.institutionId });
    }
    if (sharedIdentifier) {
      reasons.push({ field: sharedIdentifier.left.field.fieldName, signal: "same_human_verified_extraction", score: 1 });
      refs.push({ leftDocumentId: sharedIdentifier.left.documentId, leftVersion: sharedIdentifier.left.version, leftExtractionId: sharedIdentifier.left.field.id, rightDocumentId: sharedIdentifier.right.documentId, rightVersion: sharedIdentifier.right.version, rightExtractionId: sharedIdentifier.right.field.id });
    }
    if (!reasons.length) continue;
    const score = Math.max(nameScore, samePromoter ? 0.85 : 0, sharedIdentifier ? 1 : 0);
    const existing = await prisma.matchCandidate.findUnique({ where: { leftApplicationId_rightApplicationId: { leftApplicationId, rightApplicationId } }, select: { id: true } });
    await prisma.matchCandidate.upsert({
      where: { leftApplicationId_rightApplicationId: { leftApplicationId, rightApplicationId } },
      create: { tenantId, leftApplicationId, rightApplicationId, score, reasons: reasons as any, evidenceReferences: refs as any },
      update: { score, reasons: reasons as any, evidenceReferences: refs as any }
    });
    candidateKeys.push(`${leftApplicationId}:${rightApplicationId}`);
    if (!existing) count += 1;
  }
  return { candidateCount: count, candidateSignature: createHash("sha256").update(candidateKeys.sort().join("|")).digest("hex") };
}
