CREATE TYPE "DocumentProcessingState" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "ScanResult" AS ENUM ('NOT_CONFIGURED', 'CLEAN', 'INFECTED', 'ERROR');
CREATE TYPE "JobType" AS ENUM ('PROCESS_DOCUMENT', 'ANALYZE_COMPLIANCE', 'MATCH_APPLICATION', 'INGEST_FIXTURE', 'INGEST_LOCAL');
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'RETRY', 'COMPLETED', 'DEAD_LETTER');
CREATE TYPE "FindingSeverity" AS ENUM ('INFO', 'WARNING', 'HIGH');
CREATE TYPE "FindingStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');
CREATE TYPE "MatchReviewStatus" AS ENUM ('SUGGESTED', 'CONFIRMED_POTENTIAL', 'DISMISSED', 'DEFERRED');
CREATE TYPE "IngestionBatchStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "IngestionRecordStatus" AS ENUM ('NEEDS_REVIEW', 'LINKED', 'CREATED', 'IGNORED');

ALTER TABLE "Document" ADD COLUMN "processingState" "DocumentProcessingState" NOT NULL DEFAULT 'QUEUED';
ALTER TABLE "Document" ADD COLUMN "scanResult" "ScanResult" NOT NULL DEFAULT 'NOT_CONFIGURED';
ALTER TABLE "Document" ADD COLUMN "processingError" TEXT;
ALTER TABLE "Document" ADD COLUMN "processingWarnings" JSONB;
ALTER TABLE "Document" ADD COLUMN "processingAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Document" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "Document" SET "processingState" = 'SUCCEEDED' WHERE EXISTS (SELECT 1 FROM "EvidenceExtraction" e WHERE e."documentId" = "Document"."id");
UPDATE "Document" SET "processingState" = 'FAILED', "processingError" = 'Legacy upload requires explicit reprocessing.' WHERE "processingState" = 'QUEUED' AND NOT EXISTS (SELECT 1 FROM "EvidenceExtraction" e WHERE e."documentId" = "Document"."id");
CREATE INDEX "Document_applicationId_originalName_version_idx" ON "Document"("applicationId", "originalName", "version");

ALTER TABLE "EvidenceExtraction" ADD COLUMN "verifiedValue" JSONB;
ALTER TABLE "EvidenceExtraction" ADD COLUMN "extractor" TEXT NOT NULL DEFAULT 'RULES';
ALTER TABLE "EvidenceExtraction" ADD COLUMN "extractorVersion" TEXT NOT NULL DEFAULT 'rules-v1';
ALTER TABLE "EvidenceExtraction" ADD COLUMN "confidenceBasis" TEXT NOT NULL DEFAULT 'HEURISTIC_UNCALIBRATED';
ALTER TABLE "EvidenceExtraction" ADD COLUMN "sourceRunId" TEXT;
ALTER TABLE "EvidenceExtraction" ADD COLUMN "fieldOrdinal" INTEGER;
CREATE INDEX "EvidenceExtraction_documentId_fieldName_createdAt_idx" ON "EvidenceExtraction"("documentId", "fieldName", "createdAt");
CREATE UNIQUE INDEX "EvidenceExtraction_sourceRunId_fieldOrdinal_key" ON "EvidenceExtraction"("sourceRunId", "fieldOrdinal");

CREATE TABLE "EvidenceReviewEvent" (
  "id" TEXT NOT NULL,
  "extractionId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "originalValue" JSONB NOT NULL,
  "reviewedValue" JSONB NOT NULL,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvidenceReviewEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EvidenceReviewEvent_extractionId_createdAt_idx" ON "EvidenceReviewEvent"("extractionId", "createdAt");
ALTER TABLE "EvidenceReviewEvent" ADD CONSTRAINT "EvidenceReviewEvent_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "EvidenceExtraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OutboxEvent" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "OutboxEvent" ADD COLUMN "lockedAt" TIMESTAMP(3);
ALTER TABLE "OutboxEvent" ADD COLUMN "lockOwner" TEXT;
CREATE UNIQUE INDEX "OutboxEvent_idempotencyKey_key" ON "OutboxEvent"("idempotencyKey");

CREATE TABLE "BackgroundJob" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "type" "JobType" NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "progress" INTEGER NOT NULL DEFAULT 0,
  "progressMessage" TEXT,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockOwner" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BackgroundJob_idempotencyKey_key" ON "BackgroundJob"("idempotencyKey");
CREATE INDEX "BackgroundJob_status_availableAt_createdAt_idx" ON "BackgroundJob"("status", "availableAt", "createdAt");
CREATE INDEX "BackgroundJob_tenantId_createdAt_idx" ON "BackgroundJob"("tenantId", "createdAt");
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ComplianceAnalysis" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "readinessEstimate" INTEGER NOT NULL,
  "ruleVersion" TEXT NOT NULL,
  "summary" JSONB NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ComplianceAnalysis_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ComplianceAnalysis_applicationId_key" ON "ComplianceAnalysis"("applicationId");
CREATE INDEX "ComplianceAnalysis_tenantId_computedAt_idx" ON "ComplianceAnalysis"("tenantId", "computedAt");
ALTER TABLE "ComplianceAnalysis" ADD CONSTRAINT "ComplianceAnalysis_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComplianceAnalysis" ADD CONSTRAINT "ComplianceAnalysis_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ComplianceFinding" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "requirementId" TEXT,
  "dedupeKey" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "severity" "FindingSeverity" NOT NULL,
  "title" TEXT NOT NULL,
  "explanation" TEXT NOT NULL,
  "evidenceReferences" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "ruleVersion" TEXT NOT NULL,
  "status" "FindingStatus" NOT NULL DEFAULT 'OPEN',
  "resolutionNotes" TEXT,
  "resolvedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ComplianceFinding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ComplianceFinding_dedupeKey_key" ON "ComplianceFinding"("dedupeKey");
CREATE INDEX "ComplianceFinding_tenantId_applicationId_status_idx" ON "ComplianceFinding"("tenantId", "applicationId", "status");
CREATE INDEX "ComplianceFinding_applicationId_code_idx" ON "ComplianceFinding"("applicationId", "code");
ALTER TABLE "ComplianceFinding" ADD CONSTRAINT "ComplianceFinding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComplianceFinding" ADD CONSTRAINT "ComplianceFinding_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComplianceFinding" ADD CONSTRAINT "ComplianceFinding_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "MatchCandidate" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "leftApplicationId" TEXT NOT NULL,
  "rightApplicationId" TEXT NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "reasons" JSONB NOT NULL,
  "evidenceReferences" JSONB NOT NULL,
  "reviewStatus" "MatchReviewStatus" NOT NULL DEFAULT 'SUGGESTED',
  "reviewNotes" TEXT,
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MatchCandidate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MatchCandidate_leftApplicationId_rightApplicationId_key" ON "MatchCandidate"("leftApplicationId", "rightApplicationId");
CREATE INDEX "MatchCandidate_tenantId_reviewStatus_createdAt_idx" ON "MatchCandidate"("tenantId", "reviewStatus", "createdAt");
ALTER TABLE "MatchCandidate" ADD CONSTRAINT "MatchCandidate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MatchCandidate" ADD CONSTRAINT "MatchCandidate_leftApplicationId_fkey" FOREIGN KEY ("leftApplicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MatchCandidate" ADD CONSTRAINT "MatchCandidate_rightApplicationId_fkey" FOREIGN KEY ("rightApplicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Notification" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "resourceType" TEXT,
  "resourceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3),
  "idempotencyKey" TEXT,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Notification_tenantId_userId_readAt_createdAt_idx" ON "Notification"("tenantId", "userId", "readAt", "createdAt");
CREATE UNIQUE INDEX "Notification_idempotencyKey_key" ON "Notification"("idempotencyKey");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "IngestionBatch" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "sourceName" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceReference" TEXT,
  "sourceChecksum" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "status" "IngestionBatchStatus" NOT NULL DEFAULT 'QUEUED',
  "totalRecords" INTEGER NOT NULL DEFAULT 0,
  "stagedRecords" INTEGER NOT NULL DEFAULT 0,
  "linkedRecords" INTEGER NOT NULL DEFAULT 0,
  "ignoredRecords" INTEGER NOT NULL DEFAULT 0,
  "errorSummary" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IngestionBatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IngestionBatch_idempotencyKey_key" ON "IngestionBatch"("idempotencyKey");
CREATE INDEX "IngestionBatch_tenantId_status_createdAt_idx" ON "IngestionBatch"("tenantId", "status", "createdAt");
ALTER TABLE "IngestionBatch" ADD CONSTRAINT "IngestionBatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "IngestionRecord" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "sourceRecordKey" TEXT NOT NULL,
  "normalizedData" JSONB NOT NULL,
  "status" "IngestionRecordStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
  "candidateInstitutionId" TEXT,
  "candidateScore" DOUBLE PRECISION,
  "matchReasons" JSONB,
  "resolvedInstitutionId" TEXT,
  "reviewNotes" TEXT,
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IngestionRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IngestionRecord_batchId_sourceRecordKey_key" ON "IngestionRecord"("batchId", "sourceRecordKey");
CREATE INDEX "IngestionRecord_batchId_status_idx" ON "IngestionRecord"("batchId", "status");
ALTER TABLE "IngestionRecord" ADD CONSTRAINT "IngestionRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "IngestionBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IngestionRecord" ADD CONSTRAINT "IngestionRecord_candidateInstitutionId_fkey" FOREIGN KEY ("candidateInstitutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IngestionRecord" ADD CONSTRAINT "IngestionRecord_resolvedInstitutionId_fkey" FOREIGN KEY ("resolvedInstitutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
