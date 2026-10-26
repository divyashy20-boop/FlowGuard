import { prisma } from "./db";
import { graphStore } from "./graph-store";

async function main() {
  if (!graphStore.isConfigured()) throw new Error("Set NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD before rebuilding the graph.");
  const tenants = await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  for (const tenant of tenants) {
    const result = await graphStore.rebuildTenant(tenant.id);
    console.info("Graph projection rebuilt", { tenantId: tenant.id, ...result });
  }
}

void main().catch(error => {
  console.error("Graph rebuild failed", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
}).finally(async () => {
  await graphStore.close();
  await prisma.$disconnect();
});
