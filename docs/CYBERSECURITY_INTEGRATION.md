# Cybersecurity feature branch

## Reused FlowGuard protections

This branch retains the integrated JWT authentication and role authorization, tenant-scoped PostgreSQL access, Zod request validation, Helmet headers, bounded JSON bodies, security-sensitive audit events, private document quarantine and upload signature/size checks. The additions apply a per-process failed-login limit and avoid retaining raw email addresses in its attempt keys.

Five failed attempts for one normalized email and client IP trigger a 15-minute block. A successful login clears that key. The in-memory map is bounded to 10,000 keys and evicts expired entries. This is effective for a single API process; multi-instance deployments need a shared atomic rate-limit store before exposure to untrusted traffic. Configure trusted proxy handling explicitly before using forwarded client addresses.

## Interfaces and SIH_PS4 fit

FlowGuard enforces identity in Express middleware and signs JWTs for its React client. SIH_PS4 currently exposes platform metadata and documents that application commands remain denied pending scoped identity and authorization. This branch does not claim protocol compatibility or introduce login into SIH_PS4. At integration time, retain SIH_PS4's `/api/v1` and problem-response conventions, map its eventual identity claims to FlowGuard's `userId`/`tenantId`/`role`, and keep PostgreSQL tenant checks at the receiving API boundary.

## Configuration and validation

No new environment variables or migrations are required. Run `npm --workspace apps/api test -- login-throttle.test.ts` and `npm run build`. Security tests requiring `DATABASE_URL` and `JWT_SECRET` need local test values; no credentials belong in this branch.

## Limits

The limiter is process-local, does not rate-limit malformed payloads before schema validation, and does not replace edge-level abuse protection, monitoring, MFA, token revocation, or a deployment security review. Existing FlowGuard JWTs remain valid for two hours and role/membership changes are not immediately reflected until token expiry.
