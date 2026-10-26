-- Preserve review responses as first-class data without changing prior lifecycle state.
ALTER TABLE "Deficiency" ADD COLUMN "responseText" TEXT;
ALTER TABLE "Deficiency" ADD COLUMN "responseSubmittedByUserId" TEXT;
ALTER TABLE "Deficiency" ADD COLUMN "responseSubmittedAt" TIMESTAMP(3);
