# Applying the Supabase schema

The canonical migrations live in `supabase/migrations/` and are applied by the Supabase CLI. The CLI tracks them in `supabase_migrations.schema_migrations`; do not use the legacy `smartbook_schema_migrations` table.

1. Store `SUPABASE_ACCESS_TOKEN` in the ignored local `.env`.
2. Link the repository to the intended project: `npx supabase@2.121.0 link --project-ref <project-ref>`.
3. Review pending work: `npx supabase@2.121.0 db push --workdir . --project-ref <project-ref> --dry-run`.
4. Apply migrations: `npm --workspace bk095d run apply:migrations` from the repository root.
5. Confirm all migrations are recorded: `npx supabase@2.121.0 migration list --workdir . --project-ref <project-ref>`.
6. Run `npm --workspace bk095d run verify:rls` against the intended Supabase project.

The production project previously had migrations `0001`, `0002`, and `0003` applied. Migration `0004_role_scoped_ledger_access.sql` adds the role-aware data policies; apply and verify it before relying on the new company-role restrictions. Never paste `.env`, a database password, or an access token into SQL Editor or Git.
