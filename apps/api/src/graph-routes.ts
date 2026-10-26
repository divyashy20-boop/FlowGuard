import type { Express } from "express";
import { requireAuth, requireRole } from "./security";
import { graphNodeType, graphStore, type GraphStore } from "./graph-store";
import { prisma } from "./db";
import { findAuthoritativeGraphRecord } from "./graph-records";

export function registerGraphRoutes(app: Express, store: GraphStore = graphStore) {
  const canTraverse = [requireAuth, requireRole("ADMIN", "REVIEWER", "AUDITOR")];

  app.get("/graph/status", ...canTraverse, async (req, res, next) => {
    try {
      const tenantId = req.authUser!.tenantId;
      const [state, pendingEvents] = await Promise.all([
        prisma.graphProjectionState.findUnique({ where: { tenantId }, select: { version: true, nodeCount: true, edgeCount: true, lastSyncedAt: true, lastError: true } }),
        prisma.outboxEvent.count({ where: { eventType: "GRAPH_REFRESH_REQUESTED", aggregateId: tenantId, processedAt: null } })
      ]);
      const available = await store.checkAvailability().catch(() => false);
      return res.json({ configured: store.isConfigured(), available, state: !store.isConfigured() ? "unconfigured" : !available ? "unavailable" : pendingEvents ? "syncing" : "ready", projection: state, pendingEvents });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/graph/search", ...canTraverse, async (req, res, next) => {
    try {
      const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
      if (query.length < 2) return res.status(400).json({ error: "Enter at least two search characters" });
      const rawType = typeof req.query.type === "string" ? req.query.type : "";
      const type = rawType ? graphNodeType(rawType) : undefined;
      if (rawType && !type) return res.status(400).json({ error: "Unsupported graph node type" });
      const limit = Math.max(1, Math.min(40, Number(req.query.limit) || 20));
      if (!store.isConfigured()) return res.status(503).json({ error: "Graph database is not configured" });
      const graph = await store.search({ tenantId: req.authUser!.tenantId, query, type, limit: Math.min(200, limit * 4) });
      await prisma.auditEvent.create({ data: { tenantId: req.authUser!.tenantId, actorUserId: req.authUser!.userId, action: "GRAPH_SEARCHED", resourceType: "FlowGuardGraph", resourceId: req.authUser!.tenantId, metadata: { queryLength: query.length, nodeType: type ?? null, resultCount: graph.nodes.length } } });
      return res.json(graph);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/graph/nodes/:nodeId", ...canTraverse, async (req, res, next) => {
    try {
      const nodeId = req.params.nodeId.slice(0, 260);
      if (!store.isConfigured()) return res.status(503).json({ error: "Graph database is not configured" });
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 60));
      const graph = await store.expand({ tenantId: req.authUser!.tenantId, nodeId, limit });
      if (!graph.nodes.length) return res.status(404).json({ error: "Graph record not found" });
      await prisma.auditEvent.create({ data: { tenantId: req.authUser!.tenantId, actorUserId: req.authUser!.userId, action: "GRAPH_NODE_EXPANDED", resourceType: "FlowGuardGraphNode", resourceId: nodeId, metadata: { resultCount: graph.nodes.length } } });
      return res.json(graph);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/graph/records/:sourceTable/:sourceId", ...canTraverse, async (req, res, next) => {
    try {
      const sourceTable = req.params.sourceTable.slice(0, 80);
      const sourceId = req.params.sourceId.slice(0, 100);
      const record = await findAuthoritativeGraphRecord(req.authUser!.tenantId, sourceTable, sourceId);
      if (record === undefined) return res.status(400).json({ error: "Unsupported graph source type" });
      if (record === null) return res.status(404).json({ error: "Source record is not available in this tenant" });
      await prisma.auditEvent.create({ data: { tenantId: req.authUser!.tenantId, actorUserId: req.authUser!.userId, action: "GRAPH_SOURCE_VERIFIED", resourceType: sourceTable, resourceId: sourceId } });
      return res.json({ sourceTable, sourceId, authority: "POSTGRESQL", record });
    } catch (error) {
      return next(error);
    }
  });
}
