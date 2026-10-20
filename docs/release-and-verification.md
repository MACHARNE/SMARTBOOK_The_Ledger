# Releasing Smart Book

The application is hosted in Vercel project `dsmartledger`, with production domain `dsmartledger-indol.vercel.app`. Supabase project `twhnwowshcowqldpzwbo` holds production data. Never use production for disposable fixture tests.

## Before release

Run the checks listed in `bk095d/README.md`, including the build and browser suite. Apply canonical migrations to an isolated database first. Inspect the intended project, environment and source commit before deploying.

Use `supabase/migrations/` as the only migration source. Follow `apply-supabase-migrations.md` and inspect the CLI dry run before applying a pending migration. Never reapply recorded versions or commit credentials.

## Transactional ledger release

Migration 0006 introduces the RPCs required by the matching application and revokes direct client writes. Coordinate the migration and frontend release. Users with old open tabs must refresh. Do not roll back only the frontend to a version that writes directly to tables after installing 0006.

Supabase Auth's allowed redirects must include the production `/auth/invite`, `/auth/callback`, `/login`, `/signup`, `/admin/login` and `/super-admin/login` routes. Preserve existing required redirects when updating configuration.

## After release

Verify the deployed commit, callback routes, public configuration and protected API responses. Sign in with a designated test account and verify records load, report periods render, member management appears for the owner, and company sessions cannot open an admin portal.

Verify financial workflows in staging or an explicitly designated test organization. Do not insert audit fixtures into customer books. Test real invitation delivery, recovery, company status transitions and multiple roles before treating the complete launch matrix as passed. See `verification.md` and the dated audit reports for evidence and remaining limits.
