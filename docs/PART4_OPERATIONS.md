# FlowGuard Part 4 — Local setup and demonstration

Part 4 extends the integrated Parts 1–3 codebase. It does not replace the API, database, worker or existing application screens.

## Local setup

From the repository root in PowerShell:

```powershell
Copy-Item .env.example .env
Copy-Item apps/web/.env.example apps/web/.env
# Set POSTGRES_PASSWORD and the DATABASE_URL password to the same local value. Set JWT_SECRET (32+ chars) and SEED_ADMIN_PASSWORD (16+ chars) in .env.
docker compose up -d postgres
npm ci
npm run db:generate
npm run db:migrate
npm run db:seed
npm run db:seed:demo
```

The existing seed creates `admin@flowguard.local`; use the local `SEED_ADMIN_PASSWORD` you configured. The demo seed uses stable `demo-*` identifiers and upserts synthetic records; it does not delete tenant data. It creates fictional promoters/institutions/campuses, programme offerings, workflow versions, applications across stages, a deficiency and in-progress review, inspection/EVC records, a formal approved decision plus a distinct validity record, an obligation, two quarantine-only synthetic PDFs with conflicting fixture values, a potential match, an open finding, a reviewable import batch, and a visibly synthetic completed job-history entry. Seed-created PDF fixtures are not malware-scanned or OCR-processed by the seed.

Start each process in its own terminal from the repository root:

```powershell
npm run dev:api
```

```powershell
npm run dev:worker
```

```powershell
npm run dev:web
```

The API defaults to `http://localhost:4000`; the web app defaults to `http://localhost:5173`. `apps/web/.env` may set `VITE_API_URL` to the API origin for a local or production build. API environment names and validation are in `.env.example` and `apps/api/src/env.ts`. `GET /health` checks that the HTTP process responds; authenticated-independent `GET /ready` checks PostgreSQL and returns `503` when the database is unavailable.

Never reset the database for this setup. Apply the checked-in migrations in timestamp order with the existing migration command. Take an operator-managed database backup before production migration.

## Synthetic SIH walkthrough

1. Sign in as the seeded admin. **Overview** shows persisted, tenant-scoped counts, lifecycle status groups, open finding severity, processing/review queues, upcoming recorded approval expiries and recent authorized activity. Empty states mean no records are available; no live AICTE data is implied.
2. In **Registry**, create/select a promoter and institution, add campus and programme/offering records, and record an external identifier with the issuer and namespace supplied by the operator. The interface does not generate or verify official identifiers.
3. Open **Applications**. Create a draft for the right institution, campus, academic year and active workflow version; submit it. A reviewer starts review and may add a deficiency. The institution role records an actual response; a reviewer closes it after review, completes the review, and an administrator records the formal decision.
4. In **Inspections & EVC**, add application-specific inspection and EVC history. In **Approvals & obligations**, record an approval only from an approved decision, set validity dates, and track a separate continuing obligation. A decision does not automatically create an approval or letter.
5. Open **Document review** or the application detail. Upload a PDF/JPEG/PNG; see processing, scanner, and availability states separately. The default scanner is not configured, so downloads stay disabled while quarantined. Review source text/page and confidence basis; authorized reviewers can verify/correct extracted fields while preserving history. Link a document to the matching workflow requirement.
6. Refresh analysis. Inspect persisted findings in **Compliance findings**, open cited evidence, and acknowledge/resolve/dismiss with the reviewer role. A readiness value is only an estimate; linked evidence and closed findings do not constitute a compliance certification or approval.
7. Review **Matching review** and do not merge entities automatically. In **Imports**, queue the fictional fixture or choose `database/fixtures/part4-synthetic-institutions.json`; inspect staged candidates and manually link, create or ignore each record.
8. Check **Jobs**, **Notifications** and **Audit history** for persisted progress, retry/dead-letter and authorized activity. Only an admin can replay a dead-letter job.

## Configuration and production limits

- `POSTGRES_PASSWORD`, `DATABASE_URL`, `JWT_SECRET`, `PORT`, `NODE_ENV`, `WEB_ORIGIN`, `WORKER_POLL_INTERVAL_MS`, `FLOWGUARD_MAX_UPLOAD_BYTES`, `FLOWGUARD_STORAGE_DIR`, and `SEED_ADMIN_PASSWORD` are the local API settings. Keep `.env` private and outside archives.
- `VITE_API_URL` is a public build-time API origin, not a secret. Configure it for the deployment origin and restrict CORS accordingly.
- Local private-file storage must be replaced or backed by a durable private object-storage adapter for multi-instance production. Configure a real malware-scanner adapter before granting access to scanned documents. `NOT_CONFIGURED` intentionally leaves documents quarantined.
- Email delivery is an adapter stub; current notifications are in-app. OCR is local. Scanned-PDF OCR additionally needs Poppler `pdftoppm`. AI extraction, external source ingestion, official AICTE credentials, and external identifier verification are not configured.
- Production operation still requires a reviewed deployment topology, TLS and secret management, managed database backup/restore, private storage lifecycle controls, malware scanning, monitoring/alerting, worker scaling/lease review, retention policy, security review and environment-specific end-to-end verification. No production deployment is claimed.

## Validation commands

After merging/extracting into the target repo, run one consolidated pass:

```powershell
npm run db:generate
npm run build
npm test
```

The Part 4 delivery report distinguishes these checks from work that could not be verified in the restricted current environment.

