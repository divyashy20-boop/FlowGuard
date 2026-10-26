import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(30000).default(1500),
  FLOWGUARD_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(50 * 1024 * 1024).default(10 * 1024 * 1024),
  FLOWGUARD_STORAGE_DIR: z.string().optional(),
  NEO4J_URI: z.string().url().optional(),
  NEO4J_USER: z.string().min(1).optional(),
  NEO4J_PASSWORD: z.string().min(1).optional(),
  NEO4J_DATABASE: z.string().min(1).default("neo4j")
}).refine(value => {
  const configured = [value.NEO4J_URI, value.NEO4J_USER, value.NEO4J_PASSWORD].filter(Boolean).length;
  return configured === 0 || configured === 3;
}, { message: "Set NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD together" });

export const env = schema.parse(process.env);
