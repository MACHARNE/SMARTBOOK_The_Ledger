# Verification plan

## Automated checks

From the repository root:

```sh
npm --workspace bk095d run typecheck
npm --workspace bk095d run check:frontend
npm --workspace bk095d run verify:rls
```

Configure Supabase credentials in the ignored `.env` and apply all migrations first. The RLS script creates disposable Auth users and organizations, then removes them in `finally` cleanup. On the production project, it refuses to run if any organization already exists unless `SMARTBOOK_ALLOW_PRODUCTION_RLS_TESTS=true` is set after arranging a maintenance window and backup. Set `SMARTBOOK_BASE_URL` to a preview deployment to include API authorization checks.

The script verifies that Supabase REST requests cannot read/write across organizations; pending, rejected, and suspended organizations return no ledger rows and cannot write ledger rows; direct public Auth signup is disabled; public authenticated users cannot write `platform_admins`; non-admin users cannot activate an organization; a company-user JWT is denied by a super-admin API; and `/api/signup` rejects self-service company creation.

## Manual acceptance checks

1. Sign in as the initial admin at `/super-admin/login`; confirm the first login forces a password update.
2. Invite an owner, accept the email at `/signup`, and confirm pending status blocks the ledger.
3. Activate the organization; sign in at `/login` and confirm the original ledger appears with persisted data.
4. Set a 1-day, 1-week, 1-month, and 1-year trial and confirm each unit/count/end time persists and appears in the admin company list.
5. Invite a member, accept the invitation, revoke access, and change a member role. Confirm the audit trail records each change.
6. Suspend and reactivate the organization; confirm direct REST reads are blocked while suspended.
7. Spot-check credit settlement, delivered/returned dispatch income, vendor remittance, and commission payments against the preserved ledger behavior.
8. Confirm day/week/month/year report ranges and verify a company user sees no organization Excel export control.
9. As a super admin, request `/api/export/org/<organization-id>.xlsx` and confirm a valid workbook downloads.
10. Inspect built browser assets and deployment variables: no service-role key, initial-admin temporary password, or provisioning secret may be present.

The script creates and deletes temporary production records when explicitly run against production. Review cleanup counts after each live run. Do not use it while real organizations are onboarding.
