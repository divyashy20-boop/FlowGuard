# API baseline

- `GET /health` â€” process health check
- `POST /auth/login` â€” email/password login
- `GET /me` â€” current membership
- `GET /dashboard/summary` â€” tenant-scoped counts
- `GET /institutions` â€” tenant-scoped institution list
- `POST /institutions` â€” create institution for the active tenant (ADMIN or REVIEWER)

Authentication uses a short-lived JWT. This initial implementation is for local development only and needs rate limiting, stronger session controls and a wider authorization test suite before production use.
