export type ApplicationStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "DEFICIENCY_RAISED"
  | "RESUBMITTED"
  | "DECISION_ISSUED";

export type DecisionOutcome = "APPROVED" | "REJECTED" | "WITHDRAWN";

export interface ExternalIdentifier {
  issuer: string;
  namespace: string;
  value: string;
  sourceReference?: string;
  verifiedAt?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
}

export interface EvidenceExtraction {
  field: string;
  value: unknown;
  confidence: number;
  sourceDocumentId: string;
  page?: number;
  humanVerified: boolean;
  verifiedValue?: unknown;
  confidenceBasis?: string;
  extractor?: string;
  extractorVersion?: string;
}

export interface ReadinessEstimate {
  value: number;
  label: "Readiness estimate";
  computedAt: string;
  ruleVersion: string;
  meaning: string;
}

export interface EvidenceReference {
  documentId: string;
  version: number;
  extractionId?: string;
  fieldName?: string;
  pageNumber?: number | null;
  sourceText?: string | null;
}

export interface PotentialMatchSignal {
  field: string;
  signal: string;
  score: number;
  interpretation?: string;
}
