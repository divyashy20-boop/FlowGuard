# Security baseline

- Never commit `.env`, passwords, signing keys, tokens or real applicant documents.
- Tenant scoping must be enforced in server-side database queries.
- Do not trust tenant IDs supplied by the browser.
- Apply rate limits and monitoring to authentication endpoints before deployment.
- Store documents in private object storage with quarantine and malware scanning.
- Validate file signatures and sizes; do not rely only on file extensions or browser MIME types.
- Protect OCR and AI processing from prompt injection in document contents.
- Treat AI outputs as suggestions with confidence and provenance, not as formal decisions.
- Log resource identifiers and actions, not document contents, passwords, tokens or unnecessary personal data.
- Use least-privilege credentials, encrypted connections, backups and tested restore procedures.
