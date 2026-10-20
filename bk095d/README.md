# Smart Book backend

TypeScript Vercel API handlers live in `api/`. The canonical, forward-only SQL migrations live in `../supabase/migrations/`; the former duplicate migration directory has been removed.

Authentication uses Supabase Auth. Company and administrator management are available to both platform admins and super admins. Organization members read authorized data through RLS and `read_ledger_data`; writes use the versioned `save_ledger_data` and server-calculated `perform_ledger_action` functions. Ordinary table writes and client-authored audit inserts are denied. A database transaction includes related records, version checks, and audit events.

Email invitations use `/auth/invite`. Identity preparation and database provisioning happen before delivery; retrying delivery reuses the identity. Existing password holders accept with their existing account. Passwordless accounts create their own password, then sign in at the assigned portal.

## Local verification

From the repository root:

```sh
npm ci
npm run typecheck
npm --workspace bk095d run check:frontend
npm --workspace bk095d run check:database
npm --workspace bk095d run check:admin-workspace
npm --workspace bk095d run check:admin-api
npm --workspace bk095d run check:auth-callback
npm --workspace bk095d run check:admin-invite
npm --workspace bk095d run check:password-setup
npm --workspace bk095d run check:documents
npm --workspace bk095d run check:export
npm run build
npx playwright install chromium
npm run test:browser
```

`check:database` applies every canonical migration to embedded PostgreSQL and exercises financial operations, rollback, duplicates, role restrictions, tenant isolation, and conflicts. It uses no production credentials. Browser checks mock hosted Auth and APIs and send no email.

`verify:rls` creates disposable fixtures only in the separate project identified by `SMARTBOOK_STAGING_PROJECT_REF`. It unconditionally refuses the known production project. Do not use production credentials for fixture tests.

See `../docs/release-and-verification.md` for deployment, email redirects, migration order, and operational limits.

See `../docs/admin-workspace.md` for platform roles, the administrative APIs, and access management safeguards.
