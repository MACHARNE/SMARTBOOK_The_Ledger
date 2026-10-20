// Read-only production diagnostics; never print identities, credentials, or tokens.
async function main() {
  const projectUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!projectUrl || !serviceKey || !accessToken) throw new Error('Supabase diagnostic environment is not configured.');
  const ref = new URL(projectUrl).hostname.split('.')[0];
  const database = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ read_only: true, query: "select field.key as column_name, count(*)::int as null_count from auth.users u cross join lateral jsonb_each(to_jsonb(u)) field where field.key in ('confirmation_token','recovery_token','email_change_token_new','email_change','email_change_token_current','reauthentication_token') and field.value = 'null'::jsonb group by field.key order by field.key" }),
    signal: AbortSignal.timeout(30000),
  });
  if (!database.ok) throw new Error(`Read-only database query failed: HTTP ${database.status}`);
  const nullFields = await database.json();
  console.log(JSON.stringify({ check: 'null_auth_fields', rows: nullFields }));
  const auth = await fetch(`${projectUrl}/auth/v1/admin/users?page=1&per_page=50`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    signal: AbortSignal.timeout(30000),
  });
  const body = await auth.json();
  console.log(JSON.stringify({ check: 'auth_user_lookup', status: auth.status, users: body.users?.length }));
  if (!auth.ok || !Array.isArray(body.users) || !Array.isArray(nullFields) || nullFields.length) process.exitCode = 1;
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
