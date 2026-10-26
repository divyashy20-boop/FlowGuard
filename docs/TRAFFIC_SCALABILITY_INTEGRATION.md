# Traffic and scalability feature branch

## Reused FlowGuard processing

This branch retains the existing PostgreSQL-backed background job queue, transactional outbox, idempotency keys, worker leases, bounded retry/backoff, retry limits, upload/request limits, and tenant-scoped API queries. It adds optional keyset pagination for application listings and the supporting tenant/time/id index. Legacy page-number requests keep their response fields and also receive a `nextCursor` when more records are available.

Opt in with `pagination=cursor`; pass the returned cursor as `cursor` to continue. Cursor pages use a stable `(createdAt DESC, id DESC)` order, cap page size at 100, avoid large `OFFSET`s, and omit the total count query. Malformed or oversized cursor tokens return 400. Existing clients may continue using `page` and `pageSize` with the original ordering and response shape.

## Interfaces and SIH_PS4 fit

SIH_PS4 documents zero-based `page`/`size` for its public platform metadata endpoint, but its README says no application-record list endpoint is implemented yet. This branch keeps FlowGuard's current one-based page API and adds cursor support rather than claiming wire compatibility. An SIH adapter should map `size` to `pageSize`, decide on a cursor contract when the application API is implemented, and preserve tenant filters from the authenticated server context.

## Configuration, migration, and validation

No new environment variables are required. Apply the additive migration through the normal Prisma migration workflow; it adds one index and does not alter records. Run `npm --workspace apps/api test -- application-cursor.test.ts`, `npm run db:generate`, and `npm run build`.

## Limits

No throughput figure is claimed. Keyset pages are stable against inserts before the cursor, but records are ordered by creation time, not by later `updatedAt` changes. The existing queue remains PostgreSQL-backed; deployment-specific worker concurrency, database pool sizing, queue-age monitoring, and load tests still need measurement before claiming a capacity target.
