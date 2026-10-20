# Applying the Supabase schema

The canonical migrations are in `supabase/migrations/`. Supabase CLI records versions in `supabase_migrations.schema_migrations`. Do not modify a migration that has already been applied, use the legacy history table, or keep a second SQL copy.

1. Set `SUPABASE_ACCESS_TOKEN` in the ignored local `.env` and link the CLI to the intended project with `npx supabase@2.121.0 link --project-ref <ref>`.
2. Run `npm --workspace bk095d run check:database` to install all migrations in local embedded PostgreSQL and verify financial/security behavior.
3. Review pending migrations with `npm --workspace bk095d run apply:migrations -- --dry-run`.
4. Apply deliberately with `npm --workspace bk095d run apply:migrations` and verify the recorded history. The wrapper uses the linked project, not `POSTGRES_URL`.
5. Run hosted fixture tests only in the separately configured staging project. `verify:rls` always refuses production.

Migration 0005 repairs legacy NULL Auth fields. Migration 0006 introduces transactional writes, trusted audits, owner budget decisions, super-admin lifecycle checks, and recoverable onboarding provisioning. It revokes direct authenticated writes: old open application tabs must be refreshed after the matching frontend release. Coordinate the database and frontend deployment; do not restore the old frontend alone after this migration.

Never print, paste into SQL, or commit an environment file, database password, service-role key, or access token.
