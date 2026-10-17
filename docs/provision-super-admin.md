# Initial platform admin provisioning

The first platform admin is the named identity `edoziemichael90@gmail.com`. Do not use public signup or insert a password into Git or SQL.

1. Apply migrations `0001`, `0002`, and `0003` to the intended Supabase project.
2. Configure `INITIAL_ADMIN_EMAIL`, a randomly generated `INITIAL_ADMIN_TEMP_PASSWORD` (16+ characters), and a separate random `INITIAL_ADMIN_PROVISION_SECRET` as server-only Vercel variables for a controlled deployment. Do not configure these in the browser or preview deployments.
3. Call `POST https://<deployment>/api/admin/provision-initial` once with header `x-initial-admin-secret: <the one-time secret>` and an empty JSON body.
4. Sign in at `/super-admin/login` with the temporary password and set a new password when prompted.
5. Remove all three `INITIAL_ADMIN_*` Vercel variables immediately. The endpoint also refuses to run after any row exists in `platform_admins`.

The endpoint creates the confirmed Supabase Auth identity with `force_password_reset` metadata and inserts the `super_admin` role. It returns no password. Additional admins must be invited by a super admin; they set their own password through Supabase Auth.

For operator verification, this read-only query should return the named account after provisioning:

```sql
select u.email, p.role, u.raw_user_meta_data ->> 'force_password_reset' as password_reset_required
from auth.users u
join public.platform_admins p on p.user_id = u.id
where lower(u.email) = lower('edoziemichael90@gmail.com');
```

Platform admins currently use email/password and Supabase password reset. MFA and recovery hardening remain roadmap items.
