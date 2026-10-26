import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const outboxFindFirst = vi.fn();
  const outboxUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const graphStateUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const backgroundJobFindMany = vi.fn().mockResolvedValue([]);
  const backgroundJobFindFirst = vi.fn().mockResolvedValue(null);
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({ outboxEvent: { findFirst: outboxFindFirst, updateMany: outboxUpdateMany } })),
    outboxEvent: { updateMany: outboxUpdateMany },
    graphProjectionState: { updateMany: graphStateUpdateMany },
    backgroundJob: { findMany: backgroundJobFindMany, findFirst: backgroundJobFindFirst }
  };
  return { prisma, outboxFindFirst, outboxUpdateMany, graphStateUpdateMany, backgroundJobFindMany, backgroundJobFindFirst, rebuildTenant: vi.fn() };
});

vi.mock("./db", () => ({ prisma: mocks.prisma }));
vi.mock("./graph-store", () => ({ graphStore: { isConfigured: () => true, rebuildTenant: mocks.rebuildTenant }, GraphProjectionBusyError: class GraphProjectionBusyError extends Error {} }));
vi.mock("./document-storage", () => ({ localDocumentStorage: {} }));
vi.mock("./malware-scanner", () => ({ malwareScanner: {} }));
vi.mock("./document-processing-pipeline", () => ({ processDocumentBytes: vi.fn() }));
vi.mock("./job-service", () => ({ enqueueJobEvent: vi.fn() }));
vi.mock("./compliance-intelligence", () => ({ analyzeApplication: vi.fn() }));
vi.mock("./matching-intelligence", () => ({ matchApplication: vi.fn(), similarity: vi.fn() }));
vi.mock("./ingestion-adapters", () => ({ localJsonIngestionAdapter: {}, syntheticFixtureAdapter: {} }));
vi.mock("./notification-adapters", () => ({ emailAdapter: { deliver: vi.fn() } }));

import { runWorkerOnce } from "./worker-runtime";

describe("graph projection worker failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.outboxFindFirst.mockResolvedValueOnce({ id: "graph-event", aggregateId: "tenant-a", attempts: 0, eventType: "GRAPH_REFRESH_REQUESTED" }).mockResolvedValueOnce(null);
    mocks.rebuildTenant.mockRejectedValue(new Error("Neo4j unavailable"));
  });

  it("schedules a graph retry and still proceeds to claim core jobs", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runWorkerOnce()).resolves.toBe(true);
    expect(mocks.outboxUpdateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ id: "graph-event", processedAt: null }),
      data: expect.objectContaining({ availableAt: expect.any(Date), lastError: "Graph projection failed; retry scheduled." })
    }));
    expect(mocks.backgroundJobFindMany).toHaveBeenCalled();
    expect(mocks.backgroundJobFindFirst).toHaveBeenCalled();
    error.mockRestore();
  });
});
