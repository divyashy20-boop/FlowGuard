# FlowGuard Architecture â€” Foundation

## Design

- Modular monolith with separate API and future worker process.
- PostgreSQL is authoritative.
- Private object storage is planned for document bytes; database rows store metadata and storage keys.
- Outbox events are persisted in the same database so future workers can process events reliably.
- Search and graph projections, if introduced, must be rebuildable from authoritative records.

## Domain boundaries

Promoter, institution, campus, programme definition, course offering, academic year, application, requirement, document version, deficiency, review, formal decision, approval validity and obligation are separate concepts.

Application processing status is not a substitute for formal decision, approval validity, compliance status, document verification, or approval-letter availability.

## Security principles

- Scope data queries to the authenticated tenant.
- Require role checks for privileged operations.
- Keep audit events for sensitive actions.
- Never trust client-provided tenant IDs.
- Do not expose storage keys as public download URLs.
- Use quarantine, content inspection, malware scanning and immutable document versions before production document access.
