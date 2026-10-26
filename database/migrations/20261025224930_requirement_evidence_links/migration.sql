-- CreateTable
CREATE TABLE "RequirementEvidence" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "linkedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequirementEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RequirementEvidence_documentId_idx" ON "RequirementEvidence"("documentId");

-- CreateIndex
CREATE INDEX "RequirementEvidence_requirementId_idx" ON "RequirementEvidence"("requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "RequirementEvidence_requirementId_documentId_key" ON "RequirementEvidence"("requirementId", "documentId");

-- AddForeignKey
ALTER TABLE "RequirementEvidence" ADD CONSTRAINT "RequirementEvidence_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementEvidence" ADD CONSTRAINT "RequirementEvidence_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
