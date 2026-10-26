# Part 3 local operations

Run these commands from the repository root in PowerShell. Preserve the existing PostgreSQL volume and apply the forward migration; do not reset the database.

```powershell
Copy-Item .env.example .env
# Edit .env: set a private JWT_SECRET (32+ characters) and SEED_ADMIN_PASSWORD (16+ characters).
docker compose up -d postgres
npm ci
npm run db:generate
npm run db:migrate
npm run db:seed
```

Open three terminals at the repository root:

```powershell
npm run dev:api
```

```powershell
npm run dev:worker
```

```powershell
npm run dev:web
```

The API listens on `http://localhost:4000`, the web app on `http://localhost:5173`, and private uploads default to the repository's ignored `private-uploads/` directory. `WORKER_POLL_INTERVAL_MS` and `FLOWGUARD_MAX_UPLOAD_BYTES` have validated defaults. `FLOWGUARD_STORAGE_DIR` is optional. The local email adapter logs notification ID/type only; email delivery is not configured. No scanner is configured by default.

## Demonstration with synthetic records

1. Sign in to the web app with `admin@flowguard.local` and the local seed password.
2. Open **Imports**, queue **Synthetic local fixture**, then refresh and open the completed batch.
3. Review each fictional record. Link it to an existing tenant institution, create a new institution, or ignore it; no action is automatic.
4. Or choose an authorized JSON file in **Imports**. Supply a JSON array, or `{ "records": [...] }`; each record needs `sourceRecordKey`, `name`, and `institutionType` (`ENGINEERING`, `MANAGEMENT`, `PHARMACY`, `OTHER`), with optional `address` and `promoterName`. Local imports allow up to 500 records and 900 KB. Validate that you have permission to process the source data before importing it.
5. Create/open an application and upload a PDF/JPEG/PNG. The upload remains quarantined while the worker extracts any supported text/fields.
6. In **Jobs**, refresh to see job state. In the application record, refresh statuses, link the document to a workflow requirement, review/correct extracted values against their cited source text/page, then refresh compliance analysis.
7. Review persisted findings, readiness explanation and potential matches. Similarity results are suggestions and do not merge records or issue decisions.

Workflow configuration may supply `requiredFieldsByRequirement` as an object from requirement code to a list of field names. `expiryFields` may list fields (for example `validity_until`) whose human-verified dates should be checked. Without these configuration rules, the system does not infer required fields or document expiry policy.

## Validation commands

After integration, run `npm run db:generate`, `npm run build`, and `npm test`. `npm run db:migrate` applies the checked-in Part 3 migration through Prisma's development migration workflow. A real malware scan requires an installed adapter; scanned-PDF OCR also requires Poppler's `pdftoppm` executable on `PATH`.
