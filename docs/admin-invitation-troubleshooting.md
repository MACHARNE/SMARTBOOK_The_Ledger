# Admin invitation database failure

The frontend in `fb091d/app.jsx` calls `POST /api/admin/invite`. The Vercel router forwards this to `bk095d/api/admin/invite.ts`, which verifies super-admin access, invites through Supabase Auth, assigns `platform_admins`, and records an audit event.

On 18 October 2026, production Auth returned `Database error finding user` during invitation. A separate, read-only Auth admin user-list request reproduced HTTP 500 (`Database error finding users`). Database inspection found two user records with NULL `recovery_token`, `email_change_token_new`, and `email_change`. The origin of those records was not established.

Supabase documents that NULL string fields in `auth.users` can prevent Auth from scanning user records: [Auth database troubleshooting](https://supabase.com/docs/guides/troubleshooting/database-error-saving-new-user-RU_EwB).

Migration `0005_repair_auth_user_token_nulls.sql` was reviewed with the CLI dry run and applied through the Supabase CLI. It replaces only NULL values in those three fields with empty strings. Existing non-NULL tokens, identities, passwords, and access roles are preserved. After application, no NULL values remained in the six string fields checked by the diagnostic and the Auth user-list request returned HTTP 200 with five users.

Run the read-only diagnostic from the repository root with the ignored local `.env` configured:

```sh
npm --workspace bk095d run diagnose:auth
```

It prints field counts and Auth response status, without printing user identities or tokens. It does not create users or send email.

Local API handling now reports upstream Auth server errors as HTTP 502 and logs only the error code and status. This code change requires deployment; the database repair is already live. These local checks passed:

```sh
npm --workspace bk095d run typecheck
npm --workspace bk095d run check:admin-invite
```

The invitation checks mock all network requests. Actual invitation email delivery and acceptance still need to be verified by retrying the intended invitation in the app. The browser message `content页面注入成功` reports content-script injection and does not explain the Supabase failure.
