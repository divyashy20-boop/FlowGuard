# PostgreSQL graph projection integration

## FlowGuard changes

PostgreSQL remains the record of authority. Express business routes write via Prisma to PostgreSQL. Database triggers write tenant refresh intents to the same PostgreSQL outbox transaction as source creates, updates, and deletes. The worker claims those intents and rebuilds a tenant snapshot from PostgreSQL using a repeatable-read transaction. It atomically replaces that tenant's Neo4j projection; a duplicate event repeats the same replacement safely. Deleted source rows therefore disappear on the next rebuild. Failed projections retry with bounded exponential backoff, and `graph:rebuild` recreates every tenant projection after recovery.

Graph search and traversal are read-only, bounded, tenant-scoped, and role-gated. A selected node's details are re-read through an allowlisted PostgreSQL query scoped to the authenticated tenant. Graph metadata carries source table, PostgreSQL ID, projection version, and relationship field provenance. The graph layer exposes no arbitrary Cypher or mutation endpoint for future LLM use.

## SIH_PS4 reference and adapter boundary

The public SIH_PS4 `main` README describes a platform metadata shell; it states application commands remain denied until scoped identity and authorization are implemented. Its metadata endpoint uses `/api/v1`, zero-based `page`/`size`, and problem responses. Application domain routes and their database schema are not available as active contracts in that README. This branch therefore does not claim that FlowGuard route shapes or Prisma models can be merged directly into SIH_PS4.

When SIH_PS4 adds application records, map its authenticated tenant and stable record IDs to the projection inputs. Keep command/write handlers in SIH_PS4's PostgreSQL transaction, and either port the migration trigger/outbox pattern or publish an equivalent durable outbox event. Keep the graph explorer behind a server adapter that maps SIH's `/api/v1` response and error conventions. Source table/field mappings require a review against SIH's real schema before integration.

## Setup and operations

Add `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, and `NEO4J_DATABASE` to local configuration. The Compose service is optional for core operation. Apply `20261026150000_graph_projection` through Prisma migrations, seed PostgreSQL, run `npm run graph:rebuild` for the initial projection, then run the worker. `/ready` checks PostgreSQL; `/graph/status` separately reports Neo4j availability and projection state. If Neo4j is down, graph operations report unavailable while PostgreSQL routes and writes continue.

## Verification and limits

Tests cover graph authorization/tenant scoping, PostgreSQL record verification, graph-unavailable status, worker retry after Neo4j failure, and existing JWT authorization. Prisma schema validation, client generation and API/web builds are performed locally. Live PostgreSQL trigger behavior, Neo4j transaction/rebuild behavior, Docker startup and SIH_PS4 end-to-end integration require services or SIH domain APIs not verified by this source inspection.
