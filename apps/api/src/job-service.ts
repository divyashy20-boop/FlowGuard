import type { Prisma, JobType } from "@prisma/client";
import { prisma } from "./db";

export async function enqueueJobEvent(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    type: JobType;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }
) {
  return tx.outboxEvent.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    update: {},
    create: {
      eventType: "JOB_REQUESTED",
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      idempotencyKey: input.idempotencyKey,
      payload: {
        type: input.type,
        tenantId: input.tenantId,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey
      } as Prisma.InputJsonValue
    }
  });
}

export async function enqueueJob(input: Parameters<typeof enqueueJobEvent>[1]) {
  return prisma.$transaction(tx => enqueueJobEvent(tx, input));
}
