# Part 3 API

All endpoints require the existing bearer-token login unless noted. New record access is scoped to the authenticated tenant; document payloads are never returned by list endpoints.

## Document handling

- `POST /applications/:applicationId/documents` accepts one `file` field (PDF/JPEG/PNG, 10 MiB default) and returns `202` with a queued document record. The API checks the declared MIME type against a file signature and stores private content under a random storage key.
- `GET /applications/:applicationId/documents` returns document versions, scan/processing state, checksum, extraction provenance and review-event history.
- `GET /documents/:documentId/versions` lists the immutable versions grouped by application and sanitized original filename.
- `GET /documents/:documentId/download` returns an authorized attachment after verifying its checksum.
- `POST /documents/:documentId/process` queues a retry/reprocess job. The upload path queues processing automatically.
- `POST /documents/:documentId/extractions/:extractionId/verify` accepts optional `{ "verifiedValue": "corrected value", "notes": "..." }`. The original extraction remains stored; verification/correction is recorded as an immutable review event.

The default `LocalNoScannerAdapter` explicitly reports `NOT_CONFIGURED`. Such documents remain quarantined even after extraction. A scanner adapter may be replaced in `apps/api/src/malware-scanner.ts`; only an actual adapter result of `CLEAN` changes document access state to `AVAILABLE`. The optional `pdftoppm` program enables rasterization of scanned PDF pages for Tesseract OCR; processing attempts at most 20 pages.

## Analysis, jobs and notifications

- `GET /applications/:applicationId/compliance` returns requirement evidence state, persisted findings and the latest readiness estimate.
- `POST /applications/:applicationId/compliance/refresh` queues an idempotent analysis refresh; finding review uses `POST /compliance-findings/:id/review`.
- `POST /applications/:id/matches/refresh` queues deterministic matching; results use `GET /applications/:id/matches` and `PATCH /matches/:id/review`.
- `GET /jobs`, `GET /jobs/:id` and `POST /jobs/:id/replay` provide tenant-scoped job status and ADMIN-only dead-letter replay.
- `GET /notifications`, `POST /notifications/:id/read` provide in-app notifications for the signed-in user.

## Ingestion

- `POST /ingestion/fixtures` starts a bundled, fictional offline source. Optional `Idempotency-Key` makes repeat submissions idempotent.
- `POST /ingestion/local-records` accepts `{ "sourceName": "...", "records": [...] }` or a bare records array inside the selected JSON file. It validates 1–500 institution records and queues a tenant-scoped batch. Supported fields are `sourceRecordKey`, `name`, `institutionType` (`ENGINEERING`, `MANAGEMENT`, `PHARMACY`, `OTHER`), and optional `address` / `promoterName`. The frontend limits files to 900 KB. An optional `Idempotency-Key` makes repeats idempotent; reusing a key for different content returns `409`.
- `GET /ingestion/batches`, `GET /ingestion/batches/:id` show provenance and staged records.
- `PATCH /ingestion/records/:id/review` accepts `LINK_EXISTING`, `CREATE_NEW`, or `IGNORE`. No import record is merged or created without human action.

External-source adapters are disabled until an authorized, documented source and credentials are supplied. No official AICTE endpoint or identifier is assumed.
