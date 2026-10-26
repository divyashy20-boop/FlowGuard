import { env } from "./env";
import { prisma } from "./db";
import { runWorkerOnce } from "./worker-runtime";

let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

async function main() {
  console.info("FlowGuard worker started", { pollIntervalMs: env.WORKER_POLL_INTERVAL_MS });
  try {
    while (!stopping) {
      const didWork = await runWorkerOnce();
      if (!didWork) await new Promise(resolve => setTimeout(resolve, env.WORKER_POLL_INTERVAL_MS));
    }
  } finally {
    await prisma.$disconnect();
    console.info("FlowGuard worker stopped");
  }
}

void main().catch(error => {
  console.error("FlowGuard worker failed to start", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
