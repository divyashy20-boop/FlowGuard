# Part 2 API additions

All routes below require a bearer token from `POST /auth/login`. Registry writes require ADMIN or REVIEWER. Institution, campus, application, approval, and obligation access is scoped through the active tenant. Shared programme definitions are catalog data.

## Registry

- `GET/POST /promoters` — list promoters attached to tenant institutions, or create and attach a promoter by supplying `institutionId`, `name`, and optional `legalType`.
- `PUT /institutions/:id/promoter` — assign or clear a promoter with `{ "promoterId": "..." }`.
- `GET/POST /campuses` — list or create campuses. Creation requires `institutionId` and `name`.
- `GET/POST /programmes` — list or create shared programme definitions.
- `GET/POST /course-offerings` — list or create a campus/programme offering for an academic year.
- `GET/POST /external-identifiers` — record issuer, namespace, value, optional source reference, and exactly one linked institution, campus, or application. AICTE PID and application number remain distinct identifiers.

## Lifecycle records

- `POST /reviews/:id/complete` — complete an in-progress review and optionally save notes.
- `GET/POST /applications/:id/inspections` — list or record inspection schedule, completion, outcome, and findings.
- `GET/POST /applications/:id/evc-assessments` — list or record EVC committee reference, assessment date, outcome, and findings.
- `GET/POST /approvals` — list or create approval validity records. An optional `decisionId` must identify an APPROVED decision for the same tenant institution.
- `GET/POST /obligations` and `PATCH /obligations/:id` — list, create, and update obligation status (`OPEN`, `IN_PROGRESS`, `FULFILLED`, `OVERDUE`, `WAIVED`).

Workflow requirements freeze once a workflow version is used by an application; create a new version for later rule changes. A formal decision, approval validity, and approval-letter availability remain separate records. Source references are stored as supplied and are not treated as external verification.
