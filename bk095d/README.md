# Backend — `bk095d`

Backend implementation area for Supabase authentication, organization signup and activation, organization membership, tenant-scoped data access, and server-side privileged operations.

- `migrations/` — ordered SQL schema and Row Level Security changes.
- `api/` — protected server-side handlers if required by the implementation.
- `package.json` / `tsconfig.json` — TypeScript Node.js function setup.
- `migrations/` — ordered SQL schema and Row Level Security changes.
- `scripts/verify-rls.ts` — live tenant-isolation and privilege checks (requires a configured Supabase test project).
- `scripts/check-frontend-syntax.cjs` — syntax-checks the React/JSX embedded in the preserved frontend file.
- `scripts/apply-migrations.cjs` — applies numbered migrations with a history table and refuses an untracked existing schema.

Do not place privileged Supabase credentials in frontend files. See the root `PRD.md` and `pre.md` for required behavior and launch criteria.

The first integration milestone is the signup/approval foundation. It does not replace or redesign the client ledger interface. Supabase project credentials are needed before live login and database integration can be exercised.

## When project setup is needed

The schema and backend contract can be prepared in Git before using the hosted database. Apply all three migrations to a Supabase **test project** and verify email/auth behavior. Configure its project URL, anon key, and server-only service-role key in local environment settings and Vercel. Never send the secret key in chat or commit it. Provision the initial named admin (`edoziemichael90@gmail.com`) once through `/api/admin/provision-initial`, using temporary server-only environment variables and a one-time secret header. The admin must set a new password after first login; remove the provisioning variables after use.

Use root [`.env.example`](../.env.example) for local variable names. Set Supabase values in Vercel Preview and Production. `SUPABASE_SERVICE_ROLE_KEY` is server-only. Add the base URL and `/signup`, `/login`, `/admin/login`, and `/super-admin/login` paths to Supabase Auth's allowed redirect URLs. Password reset emails use `/login` as the common callback; invitations continue to use each account's assigned portal. Disable open user signups in Supabase Auth; invited users can still be created through admin/member invitation flows. See [initial admin setup](../docs/provision-super-admin.md).

After all migrations and `.env` are configured against a non-production test project, run `npm --workspace bk095d run verify:rls`. The script creates temporary test users and companies, checks cross-tenant reads/writes, pending/rejected/suspended access, public admin escalation, and self-activation, then removes its fixtures. Set `SMARTBOOK_BASE_URL` to also check non-admin API rejection and public signup denial.

Apply schema changes with `npm --workspace bk095d run apply:migrations`. The local `.env` must contain `POSTGRES_URL` or `POSTGRES_URL_NON_POOLING`; this connection string is never needed in Vercel runtime variables.

The existing client interface remains visually intact. Its entry routes now call these APIs, and its existing `window.storage.get/set` call sites use the Supabase adapter after an active organization session is confirmed. Root `api/` files are Vercel route wrappers that keep implementation code inside `bk095d/api`.
