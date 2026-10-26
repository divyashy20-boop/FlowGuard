# FlowGuard Part 4 incremental manifest

This archive layers Part 4 over the integrated Part 1–3 repository. Paths are repository-relative. Existing files listed below are replaced by their Part 4 versions; new files are marked **New**. Apply this archive after Parts 1–3 and preserve the existing database. Apply the timestamped migration with the normal migration runner; do not reset the database.

| Path | Change | Purpose and dependencies |
|---|---|---|
| `apps/api/src/server.ts` | Replaces | Data-backed dashboard, tenant-scoped institution search, readiness check and paginated audit API without returning opaque audit metadata; uses existing Prisma schema/auth. |
| `apps/api/src/application-routes.ts` | Replaces | Application search/filtering and persisted deficiency response history; uses existing application lifecycle and new nullable migration fields. |
| `apps/api/src/registry-routes.ts` | Replaces | Search and tenant-scoped registry, inspection/EVC, decision, approval and obligation APIs; uses existing registry/governance models. |
| `apps/api/src/workflow-routes.ts` | Replaces | Role-aware listing of active and versioned workflows. |
| `apps/api/src/job-routes.ts` | Replaces | Filtered jobs, findings and matching review APIs/actions; uses Part 3 jobs and intelligence models. |
| `apps/api/src/document-routes-v3.ts` | Replaces | Tenant-scoped searchable document list and processing-state filter; uses Part 3 private storage and processing pipeline. |
| `apps/api/src/ingestion-routes.ts` | Replaces | Search and filter for ingestion batches; uses Part 3 ingestion models. |
| `database/schema.prisma` | Replaces | Adds persisted response text, submitting user and submission timestamp to `Deficiency`. |
| `database/migrations/20261026140000_part4_review_response_history/migration.sql` | **New** | Additive nullable columns for response history; no destructive operations. |
| `database/demo-seed.ts` | **New** | Repeatable, fictional Part 4 SIH demonstration seed; uses existing seed admin password, Prisma models, private local storage and job outbox. |
| `database/fixtures/part4-synthetic-institutions.json` | **New** | Fictional, clearly labelled import fixture; uses the existing local-record ingestion flow. |
| `package.json` | Replaces | Adds the `db:seed:demo` workspace command. |
| `apps/api/package.json` | Replaces | Adds the `db:seed:demo` script using the existing `tsx` dependency. |
| `apps/web/src/App.tsx` | Replaces | Integrates Part 4 navigation, dashboard, role-aware actions, selected campus/programme, response UI and session expiry clearing with Parts 1–3. |
| `apps/web/src/Part4Pages.tsx` | **New** | Registry, review, inspection/EVC, governance, document review, findings, matching and audit screens; calls the persisted API. |
| `apps/web/src/style.css` | Replaces | Adds success/error and structured evidence display styles. |
| `apps/web/vite.config.ts` | Replaces | Stable local host/strict port configuration. |
| `apps/web/.env.example` | **New** | Safe public build-time API-origin setting (`VITE_API_URL`). |
| `apps/web/src/vite-env.d.ts` | **New** | Types the Vite API URL setting. |
| `docs/PART4_OPERATIONS.md` | **New** | Local setup, commands, synthetic walkthrough, environment and production limits. |
| `PART_MANIFEST.md` | **New** | This file. |
| `PART_REPORT.md` | **New** | Implementation, integration, validation and operating report. |

Integration order: install Parts 1–3, apply this archive at repository root, run `npm run db:generate`, then `npm run db:migrate`, then optionally `npm run db:seed:demo`. Do not run a destructive reset. The Part 4 demo seed is additive/upsert-based and does not delete records.
