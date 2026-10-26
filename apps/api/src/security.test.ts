import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { requireAuth, requireRole } from "./security";

const secret = process.env.JWT_SECRET;

if (!secret || secret.length < 32) {
  throw new Error("Load the root .env with a valid JWT_SECRET before running security tests.");
}

const app = express();
app.get("/private", requireAuth, (_req, res) => res.json({ ok: true }));
app.post("/admin", requireAuth, requireRole("ADMIN"), (_req, res) => res.json({ ok: true }));

function makeToken(overrides: Record<string, unknown> = {}, options: jwt.SignOptions = {}) {
  return jwt.sign(
    {
      userId: "test-user",
      tenantId: "test-tenant",
      role: "ADMIN",
      ...overrides
    },
    secret!,
    {
      algorithm: "HS256",
      expiresIn: "2h",
      issuer: "flowguard-api",
      audience: "flowguard-web",
      ...options
    }
  );
}

describe("FlowGuard JWT authorization", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects requests without a bearer token", async () => {
    await request(app).get("/private").expect(401);
  });

  it("accepts a correctly signed token with the expected issuer and audience", async () => {
    await request(app)
      .get("/private")
      .set("Authorization", `Bearer ${makeToken()}`)
      .expect(200, { ok: true });
  });

  it("rejects a tampered token", async () => {
    const token = makeToken() + "tampered";
    await request(app).get("/private").set("Authorization", `Bearer ${token}`).expect(401);
  });

  it("rejects a token with the wrong issuer", async () => {
    const token = makeToken({}, { issuer: "unexpected-issuer" });
    await request(app).get("/private").set("Authorization", `Bearer ${token}`).expect(401);
  });

  it("rejects a token with the wrong audience", async () => {
    const token = makeToken({}, { audience: "unexpected-audience" });
    await request(app).get("/private").set("Authorization", `Bearer ${token}`).expect(401);
  });

  it("rejects an expired token", async () => {
    const token = makeToken({}, { expiresIn: "-1s" });
    await request(app).get("/private").set("Authorization", `Bearer ${token}`).expect(401);
  });

  it("blocks non-admin roles from admin-only routes", async () => {
    const token = makeToken({ role: "INSTITUTION_USER" });
    await request(app).post("/admin").set("Authorization", `Bearer ${token}`).expect(403);
  });
});