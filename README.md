# FlowGuard

FlowGuard is a locally runnable, multi-tenant workflow and evidence-intelligence platform for managing institution applications, reviews, documents, compliance findings and approvals. It is a synthetic demonstration build and is not an official AICTE service.

## Included

- React + Vite application and Express API with JWT authentication
- PostgreSQL + Prisma schema and additive migrations
- Tenant-scoped registry, application, document, compliance, matching and governance APIs
- Versioned workflows, deficiencies and responses, reviews, inspections/EVC, formal decisions, approvals and obligations
- Private document storage, quarantine states, extraction provenance, compliance analysis and review queues
- Background worker, transactional outbox, jobs and in-app notifications
- Synthetic repeatable SIH demo data and import fixture

## Requirements

- Node.js 20 or newer
- npm
- Docker Desktop for local PostgreSQL

## Local setup

1. Copy `.env.example` to `.env` and `apps/web/.env.example` to `apps/web/.env`.
2. Set `JWT_SECRET` to at least 32 characters and `SEED_ADMIN_PASSWORD` to at least 16 characters in `.env`.
3. Start PostgreSQL: `docker compose up -d postgres`.
4. Install the locked dependencies: `npm ci`.
5. Generate Prisma client and apply migrations: `npm run db:generate`, then `npm run db:migrate`.
6. Seed the local admin, then the fictional demo records: `npm run db:seed` and `npm run db:seed:demo`.
7. Start the API, worker and frontend in separate terminals: `npm run dev:api`, `npm run dev:worker` and `npm run dev:web`.

Open http://localhost:5173. Sign in with `admin@flowguard.local` and the local password configured in `SEED_ADMIN_PASSWORD`. The API defaults to http://localhost:4000; `/health` checks the HTTP process and `/ready` checks database readiness.

For the full synthetic walkthrough, configuration and production limits, see [docs/PART4_OPERATIONS.md](docs/PART4_OPERATIONS.md).

## Important

This build is not production-deployed or an official compliance system. Production use needs a security review, durable private object storage, configured malware scanning, managed backups, monitoring, deployment hardening and verification of applicable rules by authorized experts. Optional external integrations are not configured.

AI-assisted extraction is not proof of authenticity or an approval decision. Institution identity must not be merged based only on similar names or a shared promoter. External identifiers retain their issuer and namespace; the application does not invent official identifiers.
