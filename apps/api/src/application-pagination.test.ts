import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { registerApplicationRoutes } from "./application-routes";
import { encodeApplicationCursor } from "./application-cursor";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), count: vi.fn() }));
vi.mock("./db", () => ({ prisma: { application: { findMany: mocks.findMany, count: mocks.count } } }));

const secret = process.env.JWT_SECRET!;
const token = jwt.sign({ userId: "user-a", tenantId: "tenant-a", role: "REVIEWER" }, secret, { issuer: "flowguard-api", audience: "flowguard-web" });

function createApp() {
  const app = express();
  registerApplicationRoutes(app);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: String(error) }));
  return app;
}

describe("application keyset pagination", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a cursor and skips the total count for cursor pages", async () => {
    const createdAt = new Date("2026-10-26T12:00:00.000Z");
    mocks.findMany.mockResolvedValue([
      { id: "application-c", createdAt },
      { id: "application-b", createdAt },
      { id: "application-a", createdAt }
    ]);
    const response = await request(createApp()).get("/applications?pagination=cursor&pageSize=2&q=sample").set("Authorization", `Bearer ${token}`).expect(200);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-a", OR: expect.any(Array) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 3
    }));
    expect(mocks.count).not.toHaveBeenCalled();
    expect(response.body.items.map((item: { id: string }) => item.id)).toEqual(["application-c", "application-b"]);
    expect(response.body.nextCursor).toBeTruthy();
  });

  it("applies a validated cursor together with tenant and search filters", async () => {
    mocks.findMany.mockResolvedValue([]);
    await request(createApp()).get("/applications?pagination=cursor&cursor=not-a-cursor&q=sample").set("Authorization", `Bearer ${token}`).expect(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
    const cursor = encodeApplicationCursor({ id: "application-b", createdAt: new Date("2026-10-26T12:00:00.000Z") });
    await request(createApp()).get(`/applications?pagination=cursor&cursor=${encodeURIComponent(cursor)}&q=sample`).set("Authorization", `Bearer ${token}`).expect(200);
    const query = mocks.findMany.mock.calls[0][0];
    expect(query.where.AND[0]).toMatchObject({ tenantId: "tenant-a", OR: expect.any(Array) });
    expect(query.where.AND[1].OR).toEqual([
      { createdAt: { lt: new Date("2026-10-26T12:00:00.000Z") } },
      { createdAt: new Date("2026-10-26T12:00:00.000Z"), id: { lt: "application-b" } }
    ]);
  });

  it("preserves the legacy offset response and count behavior", async () => {
    mocks.findMany.mockResolvedValue([{ id: "application-a" }]);
    mocks.count.mockResolvedValue(1);
    const response = await request(createApp()).get("/applications?page=1&pageSize=20").set("Authorization", `Bearer ${token}`).expect(200);
    expect(response.body).toMatchObject({ total: 1, page: 1, pageSize: 20, items: [{ id: "application-a" }] });
  });
});
