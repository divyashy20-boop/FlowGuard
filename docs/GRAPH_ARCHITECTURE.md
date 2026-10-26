# FlowGuard graph architecture

## Data ownership

PostgreSQL remains authoritative for transactions, workflow state, permissions, audit history, identifiers and document metadata. Neo4j stores a tenant-partitioned graph projection used for relationship traversal. The graph is a first-class queryable graph store; it does not replace PostgreSQL transaction records.

The current schema supports these projected records: Promoter, Institution, Campus, Programme, CourseOffering, Application, WorkflowDefinition, Requirement, Document, EvidenceExtraction, Deficiency, Review, Inspection, EvcAssessment, FormalDecision, Approval, Obligation and ExternalIdentifier. The projection uses recorded foreign keys and the exact course offering key (programme, campus and academic year); the latter is marked `EXACT_KEY_MATCH`, distinct from foreign-key provenance. It does not infer a Trust, Society, Section 8 entity, response record, document-version table, or other entity absent from the schema. Existing `Document.version` is retained on each document node.

Application numbers remain an `applicationNumber` detail. External identifiers remain separate records with their supplied issuer and namespace. The graph does not label either as an AICTE PID without source evidence. Similar names do not create graph links; identities are joined only through existing database foreign keys. Relationship provenance records the source table and field, and FK-backed links carry `VERIFIED_FOREIGN_KEY` state.

## Reliable synchronization

PostgreSQL triggers add a `GRAPH_REFRESH_REQUESTED` row to the existing outbox in the same transaction as writes to projected tables. Events for one tenant in a single transaction are coalesced. The worker claims graph events with a lease, rebuilds the tenant snapshot, and replaces that tenant's graph within a Neo4j transaction. Rebuilds are idempotent; failed events retry with exponential backoff up to ten attempts. Projection version, counts, last success and a safe error summary are stored in `GraphProjectionState`; `/graph/status` reports tenant-scoped sync status.

The initial backfill and recovery path is `npm run graph:rebuild`. It rebuilds each tenant from PostgreSQL. Run it after migration and demo seeding, and after restoring or replacing Neo4j. A rebuild does not edit the PostgreSQL source records. Neo4j constraints are created automatically by the graph worker.

## Access and data handling

Graph search and traversal require a valid JWT and `ADMIN`, `REVIEWER` or `AUDITOR` role. The current membership model grants roles at tenant level and has no institution-level assignment for `INSTITUTION_USER`; that role is therefore denied graph traversal. Every Neo4j query includes the authenticated tenant ID for both anchor and neighbor nodes. Search, type filters, limits and record IDs use parameters; relationship types are stored as data, not interpolated Cypher. Search results and neighbor expansion are bounded, and only metadata needed to understand relationships is projected. Document storage keys, extracted source text and reviewer notes are excluded.

Graph searches and expansions add tenant-scoped audit events without storing the search text. The graph API is read-only. Node provenance exposes its source table, internal record ID and projection version; external identifier details retain source/verification metadata. Selecting a node calls `GET /graph/records/:sourceTable/:sourceId`, which uses an allowlisted Prisma query with the authenticated tenant scope to read current values from PostgreSQL. A deleted or cross-tenant source returns 404 even if a stale node remains in Neo4j. The UI labels graph values as projection metadata and displays selected record fields only after PostgreSQL confirms them.

`GET /graph/status` checks Neo4j availability and reads projection/outbox state from PostgreSQL. It reports `unconfigured`, `unavailable`, `syncing` or `ready`; the API's `/ready` endpoint continues to check PostgreSQL only. Graph routes fail independently, and worker graph errors are retried without changing PostgreSQL source records or blocking normal job processing.

## Local and production operations

Local development uses PostgreSQL 16 and Neo4j 5 Community via Docker Compose. Configure `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` and `NEO4J_DATABASE` together. Production deployments need a reachable, TLS-protected Neo4j endpoint and managed credentials, durable PostgreSQL and Neo4j backups, access controls, monitoring for outbox age/retries and Neo4j availability, and a tested graph rebuild procedure. Do not expose Neo4j browser or Bolt ports publicly without deployment-specific network controls. PostgreSQL remains the recovery source of truth.

Tenant rebuilds replace the complete projected tenant subgraph atomically. For tenants with very large record counts, monitor rebuild duration and Neo4j transaction memory; incremental per-record projection is a future scale optimization. A failed projection is retried, and the graph status endpoint surfaces pending work and the last safe error summary.
