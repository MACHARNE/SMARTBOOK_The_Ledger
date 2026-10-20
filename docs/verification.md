# Verification plan

## Environment boundaries

- **Production Supabase project `twhnwowshcowqldpzwbo`:** run only the read-only cross-tenant check below and the manual role matrix. Do not run `verify:rls`, any other automated test that creates or changes Auth users or organization data, or any production override flag.
- **Staging Supabase project:** run the automated RLS suite only after a separate staging project and its credentials have been provisioned. Use staging credentials in the ignored `.env`; never point the suite at production. The suite creates temporary Auth users, organizations, and ledger rows, then attempts cleanup.
- Migration `0004_role_scoped_ledger_access.sql` is already applied to production and recorded in `supabase_migrations.schema_migrations`. Do not reapply it. Any future policy change must be a new migration.

## Non-mutating local checks

From the repository root, these checks do not connect to Supabase or alter database data:

```sh
npm --workspace bk095d run typecheck
npm --workspace bk095d run check:frontend
npm --workspace bk095d run check:export
```

## Automated RLS checks — staging only

Run this only when `.env` contains credentials for the separately provisioned staging project:

```sh
npm --workspace bk095d run verify:rls
```

The suite creates disposable Auth users, organizations, and sample ledger rows, exercises tenant isolation and role policies, and removes its test records in cleanup. It can also call a deployment API when `SMARTBOOK_BASE_URL` is configured. Never set `SMARTBOOK_ALLOW_PRODUCTION_RLS_TESTS` for production and never use production credentials for this command. If staging credentials are not available, stop before running it.

The automated suite covers cross-organization REST access, staff and viewer restrictions, platform-admin isolation, organization-status restrictions, public signup and platform-admin write restrictions, protected admin APIs, and `/api/signup` behavior.

## Production read-only cross-tenant check

Run this in the browser console while signed in to the production site as an ordinary member of an active organization. It uses the current user's session and the public anon key, makes only `SELECT` requests, and prints status and row counts—not session tokens or ledger data.

Use your own organization ID and a real second organization ID known to contain at least one transaction. An unknown or empty organization is not a useful isolation check. Replace both placeholders below before running:

```js
async function visibleTransactionCount(orgId) {
  const { data: { session } } = await window.sbClient.auth.getSession();
  if (!session) throw new Error("Sign in to the production app first.");

  const configResponse = await fetch("/api/config", { cache: "no-store" });
  if (!configResponse.ok) throw new Error(`/api/config returned ${configResponse.status}`);
  const config = await configResponse.json();

  const url = new URL("/rest/v1/transactions", config.url);
  url.search = new URLSearchParams({
    select: "id",
    organization_id: `eq.${orgId}`,
    limit: "1",
  }).toString();

  const response = await fetch(url, {
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${session.access_token}`,
    },
  });
  const rows = await response.json();
  if (!response.ok || !Array.isArray(rows)) {
    throw new Error(`Transaction read returned ${response.status}`);
  }
  return { status: response.status, visibleRows: rows.length };
}

console.log({
  own: await visibleTransactionCount("YOUR_OWN_ORG_UUID"),
  other: await visibleTransactionCount("KNOWN_OTHER_ORG_UUID"),
});
```

Expected: the own-organization check sees at least one row; the known other organization returns HTTP `200` with `visibleRows: 0`. Do not copy, log, or share the session token.

## Manual role matrix

Use designated test accounts and a dedicated test organization. For production, do not create, edit, or delete test records in a real customer's ledger. Confirm each account belongs to the expected organization and role before testing. Test UI actions and, where noted, verify that a denied action did not change the record.

| Role | Expected access |
| --- | --- |
| Owner | Read own organization's ledger; manage members, business settings, categories, stock, and ledger records; approve or reject budgets; settle credit; update dispatches; remit vendors and pay commissions. No access to another organization's data. |
| Accountant | Read and manage own organization's ledger and settings; manage members and business configuration; approve or reject budgets; settle credit; update dispatches; remit vendors and pay commissions. No access to another organization's data. **The current app and migration allow accountants to approve/reject budgets, while the PRD assigns approval to the owner/approver. Treat this as a known policy/product mismatch, not a passed PRD acceptance check.** |
| Staff | Read own organization's ledger; create sales, outstanding credit sales, and dispatch drafts. Must be denied expense/procurement entry, credit settlement, edit/delete of financial records, settings/member management, vendor remittance, commission payment, and marking dispatches delivered. No access to another organization's data. |
| Viewer | Read own organization's ledger only. All create, edit, delete, approval, payment, settings, and member-management actions must be denied. No access to another organization's data. |

For each role, verify both the expected allowed operations and representative denied operations. Record the account role, action, result, and whether the database state changed. Do not use service-role credentials for these checks.

## Application acceptance checks

1. Sign in at `/super-admin/login`; verify required first-login password update. Invite a platform admin and a super admin; verify each email routes to the correct portal and the wrong role cannot sign in there.
2. Invite an owner, accept the email at `/signup`, and verify a pending organization cannot access its ledger.
3. Activate the organization; sign in at `/login` and confirm its existing ledger data is present.
4. Exercise trial durations of one day, one week, one month, and one year; confirm count, unit, end time, and displayed status.
5. Invite a member, accept the invitation, revoke access, and change a member role. Verify the audit trail records each action.
6. Verify suspended organizations are blocked from ledger access and that reactivation restores access. Use the designated test organization.
7. Check credit settlement, delivered and returned dispatch income, vendor remittance, and commission payments against expected ledger totals. Use test records and confirm each action is recorded once.
8. Confirm day, week, and month report ranges and that company users do not see organization export controls.
9. As a super admin, verify `/api/export/org/<organization-id>.xlsx` returns a valid workbook.
10. Inspect built browser assets and deployment variables to ensure service-role keys, initial-admin temporary passwords, and provisioning secrets are not exposed to browsers.
