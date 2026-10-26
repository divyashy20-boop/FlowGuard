CREATE TYPE "ObligationStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'FULFILLED', 'OVERDUE', 'WAIVED');

ALTER TABLE "Approval" ADD COLUMN "decisionId" TEXT;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_decisionId_key" UNIQUE ("decisionId");
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "FormalDecision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Approval_institutionId_academicYear_idx" ON "Approval"("institutionId", "academicYear");

ALTER TABLE "Obligation" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Obligation" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Obligation" ALTER COLUMN "status" TYPE "ObligationStatus" USING
  CASE WHEN "status" IN ('OPEN', 'IN_PROGRESS', 'FULFILLED', 'OVERDUE', 'WAIVED') THEN "status"::"ObligationStatus" ELSE 'OPEN'::"ObligationStatus" END;
ALTER TABLE "Obligation" ALTER COLUMN "status" SET DEFAULT 'OPEN';
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Obligation_institutionId_status_idx" ON "Obligation"("institutionId", "status");

CREATE TABLE "Inspection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "findings" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Inspection_tenantId_applicationId_createdAt_idx" ON "Inspection"("tenantId", "applicationId", "createdAt");
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "EvcAssessment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "committeeReference" TEXT,
    "assessedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "findings" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvcAssessment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EvcAssessment_tenantId_applicationId_createdAt_idx" ON "EvcAssessment"("tenantId", "applicationId", "createdAt");
ALTER TABLE "EvcAssessment" ADD CONSTRAINT "EvcAssessment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvcAssessment" ADD CONSTRAINT "EvcAssessment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
