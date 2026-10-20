# Platform administration

The platform workspace is separate from each company's ledger. Super admins sign in at `/super-admin/login`; platform admins use `/admin/login`. Company users use `/login`.

| Capability | Super admin | Platform admin |
| --- | --- | --- |
| Overview, company search and trial filters | Yes | Yes |
| Onboarding queue and decision history | Yes | Yes |
| Administrative activity log | Yes | Yes |
| Invite company owners, approve, reject, suspend, reactivate | Yes | Yes |
| Change trial dates and download company workbooks | Yes | Yes |
| Invite administrators, change roles, remove platform access | Yes | Yes |

Lists use server pagination of 20 records, literal searches and stable ordering. Counts come from the database. The trial summary opens active companies whose trial dates end within seven days. Trial dates are informational; company status controls operational access.

Company decisions and access removal require confirmation. Rejection, suspension and administrator removal require a reason. A failed save preserves the form and shows an error; loading and failed reads have separate states. Requests are cancelled when filters change, and submissions are locked until the server responds.

Migration `0007_admin_workspace.sql` adds server-only summary, administrator listing and access management functions. Migration `0008_platform_admin_management.sql` gives both platform roles company and administrator management, including assignment of either platform role. Every function validates the authenticated actor forwarded by the API; company users have no platform-management access. Self-access changes are disallowed through both management and invitation provisioning, the last super admin is protected, and access changes share the provisioning transaction lock. Revocation preserves the Auth identity, company memberships and historical approval attribution. Role checks take effect on the next protected request.

New authenticated endpoints:

- `GET /api/admin/overview`
- `GET /api/admin/administrators` (either platform role)
- `POST /api/admin/administrators` (either platform role; `change-role` or `revoke`)
- `GET /api/admin/activity`

Company and request endpoints accept `page`, `search` and `status`. Company status also accepts `trial_ending` and `trial_expired`. The activity endpoint accepts a whitelisted `action`. All administrative reads use `Cache-Control: no-store`. Activity responses expose administrative metadata and reasons; financial before/after payloads are excluded.

Verification uses isolated PostgreSQL for migrations and permission enforcement, real API handlers with mocked upstream services, and Playwright fixtures for both platform roles. These checks send no email and do not change production company records. A live privileged-session check still requires an administrator's own login.
