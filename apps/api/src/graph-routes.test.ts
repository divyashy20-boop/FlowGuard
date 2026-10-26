import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { registerGraphRoutes } from "./graph-routes";
import type { GraphResult, GraphStore } from "./graph-store";

const mocks = vi.hoisted(() => ({ createAuditEvent: vi.fn().mockResolvedValue({}), findInstitution: vi.fn(), graphState: vi.fn(), pendingGraphEvents: vi.fn() }));
vi.mock("./db", () => ({ prisma: { auditEvent: { create: mocks.createAuditEvent }, institution: { findFirst: mocks.findInstitution }, graphProjectionState: { findUnique: mocks.graphState }, outboxEvent: { count: mocks.pendingGraphEvents } } }));

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) throw new Error("Set JWT_SECRET to a value with at least 32 characters before running graph route tests.");

const tenantGraphs: Record<string, GraphResult> = {
  "tenant-a": { nodes: [{ id: "INSTITUTION:a", type: "INSTITUTION", label: "North Institute", details: {}, provenance: { sourceTable: "Institution", sourceId: "a", projectionVersion: 1 } }], edges: [] },
  "tenant-b": { nodes: [{ id: "INSTITUTION:b", type: "INSTITUTION", label: "South Institute", details: {}, provenance: { sourceTable: "Institution", sourceId: "b", projectionVersion: 1 } }], edges: [] }
};

const graphStore: GraphStore = {
  isConfigured: () => true,
  checkAvailability: vi.fn(async () => true),
  search: vi.fn(async input => ({ ...tenantGraphs[input.tenantId], edges: [] })),
  expand: vi.fn(async input => ({ ...tenantGraphs[input.tenantId], edges: [] })),
  rebuildTenant: vi.fn(async () => ({ version: 1, nodeCount: 0, edgeCount: 0 })),
  close: vi.fn(async () => undefined)
};

function createApp() {
  const app = express();
  registerGraphRoutes(app, graphStore);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: String(error) }));
  return app;
}

function token(tenantId: string, role: string) {
  return jwt.sign({ userId: "test-user", tenantId, role }, secret!, { algorithm: "HS256", expiresIn: "2h", issuer: "flowguard-api", audience: "flowguard-web" });
}

describe("tenant graph traversal authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAuditEvent.mockResolvedValue({});
    mocks.findInstitution.mockResolvedValue({ id: "a", name: "North Institute", institutionType: "ENGINEERING" });
    mocks.graphState.mockResolvedValue(null);
    mocks.pendingGraphEvents.mockResolvedValue(0);
  });

  it("rejects graph search without authentication", async () => {
    await request(createApp()).get("/graph/search?q=North").expect(401);
    expect(graphStore.search).not.toHaveBeenCalled();
  });

  it("denies institution users graph traversal", async () => {
    await request(createApp()).get("/graph/search?q=North").set("Authorization", `Bearer ${token("tenant-a", "INSTITUTION_USER")}`).expect(403);
    expect(graphStore.search).not.toHaveBeenCalled();
  });

  it("passes only the authenticated tenant into graph search", async () => {
    const response = await request(createApp()).get("/graph/search?q=Institute").set("Authorization", `Bearer ${token("tenant-a", "REVIEWER")}`).expect(200);
    expect(graphStore.search).toHaveBeenCalledWith({ tenantId: "tenant-a", query: "Institute", type: undefined, limit: 80 });
    expect(response.body.nodes.map((node: { id: string }) => node.id)).toEqual(["INSTITUTION:a"]);
    expect(JSON.stringify(response.body)).not.toContain("South Institute");
  });

  it("scopes node expansion to the caller tenant", async () => {
    const response = await request(createApp()).get("/graph/nodes/INSTITUTION%3Aa").set("Authorization", `Bearer ${token("tenant-a", "AUDITOR")}`).expect(200);
    expect(graphStore.expand).toHaveBeenCalledWith({ tenantId: "tenant-a", nodeId: "INSTITUTION:a", limit: 60 });
    expect(response.body.nodes.map((node: { id: string }) => node.id)).toEqual(["INSTITUTION:a"]);
  });

  it("reads selected record details from PostgreSQL with the authenticated tenant", async () => {
    const response = await request(createApp()).get("/graph/records/Institution/a").set("Authorization", `Bearer ${token("tenant-a", "REVIEWER")}`).expect(200);
    expect(mocks.findInstitution).toHaveBeenCalledWith({ where: { id: "a", tenantId: "tenant-a" }, select: { id: true, name: true, institutionType: true, archivedAt: true, createdAt: true } });
    expect(response.body.authority).toBe("POSTGRESQL");
    expect(response.body.record.name).toBe("North Institute");
  });

  it("does not reveal graph sources outside the caller tenant", async () => {
    mocks.findInstitution.mockResolvedValue(null);
    await request(createApp()).get("/graph/records/Institution/b").set("Authorization", `Bearer ${token("tenant-a", "REVIEWER")}`).expect(404);
  });

  it("reports an unavailable graph without turning it into an API outage", async () => {
    vi.mocked(graphStore.checkAvailability).mockResolvedValueOnce(false);
    const response = await request(createApp()).get("/graph/status").set("Authorization", `Bearer ${token("tenant-a", "AUDITOR")}`).expect(200);
    expect(response.body).toMatchObject({ configured: true, available: false, state: "unavailable" });
  });
});
