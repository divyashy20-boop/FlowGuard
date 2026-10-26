import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200)
});

export const createInstitutionSchema = z.object({
  name: z.string().trim().min(2).max(200),
  institutionType: z.enum(["ENGINEERING", "MANAGEMENT", "PHARMACY", "OTHER"])
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateInstitutionInput = z.infer<typeof createInstitutionSchema>;

export const documentProcessingStateSchema = z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"]);
export const scanResultSchema = z.enum(["NOT_CONFIGURED", "CLEAN", "INFECTED", "ERROR"]);
export const jobStatusSchema = z.enum(["PENDING", "RUNNING", "RETRY", "COMPLETED", "DEAD_LETTER"]);
export const findingStatusSchema = z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "DISMISSED"]);
export const matchReviewStatusSchema = z.enum(["SUGGESTED", "CONFIRMED_POTENTIAL", "DISMISSED", "DEFERRED"]);

export type DocumentProcessingState = z.infer<typeof documentProcessingStateSchema>;
export type ScanResult = z.infer<typeof scanResultSchema>;
export type BackgroundJobStatus = z.infer<typeof jobStatusSchema>;
export type ComplianceFindingStatus = z.infer<typeof findingStatusSchema>;
export type MatchReviewStatus = z.infer<typeof matchReviewStatusSchema>;
