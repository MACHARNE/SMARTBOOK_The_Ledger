import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
if (!url || !anonKey || !serviceKey) throw new Error("Set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY first.");

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = `Rls-test-${crypto.randomUUID()}-Aa9!`;
const users: string[] = [];
const orgs: string[] = [];
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(`RLS verification failed: ${message}`); };

async function createUser(email: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error || new Error("Test user could not be created.");
  users.push(data.user.id);
  return data.user.id;
}

async function main() {
  const { count: existingOrganizations, error: organizationCountError } = await admin
    .from("organizations")
    .select("id", { count: "exact", head: true });
  if (organizationCountError) throw organizationCountError;
  const isTargetProduction = new URL(url!).hostname.startsWith("twhnwowshcowqldpzwbo.");
  if (isTargetProduction && existingOrganizations !== 0 && process.env.SMARTBOOK_ALLOW_PRODUCTION_RLS_TESTS !== "true") {
    throw new Error("Refusing production RLS tests because organizations already exist. Set SMARTBOOK_ALLOW_PRODUCTION_RLS_TESTS=true only after arranging a maintenance window and backup.");
  }

  const userA = await createUser(`rls-a-${suffix}@example.test`);
  const userB = await createUser(`rls-b-${suffix}@example.test`);
  const makeOrg = async (name: string, userId: string) => {
    const { data, error } = await admin.from("organizations").insert({ name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}`, status: "active" }).select("id").single();
    if (error || !data) throw error || new Error("Test organization could not be created.");
    orgs.push(data.id);
    const member = await admin.from("organization_members").insert({ organization_id: data.id, user_id: userId, role: "owner", status: "active" });
    if (member.error) throw member.error;
    const category = await admin.from("categories").insert({ organization_id: data.id, id: "test_income", category_type: "income", label: "Test income", cogs: false, payload: { id: "test_income", label: "Test income" } });
    if (category.error) throw category.error;
    return data.id as string;
  };
  const orgA = await makeOrg(`RLS Test A ${suffix}`, userA);
  const orgB = await makeOrg(`RLS Test B ${suffix}`, userB);
  const secretRecord = await admin.from("transactions").insert({
    organization_id: orgB, id: "secret-row", date: "2026-01-01", transaction_type: "income", category_id: "test_income", amount: 120,
    payload: { id: "secret-row", date: "2026-01-01", type: "income", category: "test_income", amount: 120 },
  });
  if (secretRecord.error) throw secretRecord.error;

  const clientA = createClient(url!, anonKey!, { auth: { autoRefreshToken: false, persistSession: false } });
  const clientB = createClient(url!, anonKey!, { auth: { autoRefreshToken: false, persistSession: false } });
  const loginA = await clientA.auth.signInWithPassword({ email: `rls-a-${suffix}@example.test`, password });
  const loginB = await clientB.auth.signInWithPassword({ email: `rls-b-${suffix}@example.test`, password });
  if (loginA.error || loginB.error) throw loginA.error || loginB.error;

  const crossRead = await clientA.from("transactions").select("id").eq("organization_id", orgB);
  assert(!crossRead.error && crossRead.data?.length === 0, "organization A must not read organization B rows");
  const crossWrite = await clientA.from("transactions").insert({
    organization_id: orgB, id: "forged-row", date: "2026-01-02", transaction_type: "income", category_id: "test_income", amount: 1,
    payload: { id: "forged-row", amount: 1 },
  });
  assert(crossWrite.error?.code === "42501", "organization A must not write into organization B (RLS must deny the write)");

  const pending = await admin.from("organizations").update({ status: "pending" }).eq("id", orgA);
  if (pending.error) throw pending.error;
  const pendingRead = await clientA.from("transactions").select("id");
  assert(!pendingRead.error && pendingRead.data?.length === 0, "pending organizations must have no ledger access");
  const pendingWrite = await clientA.from("transactions").insert({
    organization_id: orgA, id: "pending-write", date: "2026-01-02", transaction_type: "income", category_id: "test_income", amount: 1,
    payload: { id: "pending-write", amount: 1 },
  });
  assert(pendingWrite.error?.code === "42501", "pending organizations must not write ledger rows");
  const rejected = await admin.from("organizations").update({ status: "rejected" }).eq("id", orgA);
  if (rejected.error) throw rejected.error;
  const rejectedRead = await clientA.from("transactions").select("id");
  assert(!rejectedRead.error && rejectedRead.data?.length === 0, "rejected organizations must have no ledger access");
  const suspended = await admin.from("organizations").update({ status: "suspended" }).eq("id", orgB);
  if (suspended.error) throw suspended.error;
  const suspendedRead = await clientB.from("transactions").select("id");
  assert(!suspendedRead.error && suspendedRead.data?.length === 0, "suspended organizations must have no ledger access");
  const suspendedWrite = await clientB.from("transactions").insert({
    organization_id: orgB, id: "suspended-write", date: "2026-01-03", transaction_type: "income", category_id: "test_income", amount: 1,
    payload: { id: "suspended-write", amount: 1 },
  });
  assert(suspendedWrite.error?.code === "42501", "suspended organizations must not write ledger rows");

  const publicAdminWrite = await clientA.from("platform_admins").insert({ user_id: userA });
  assert(!!publicAdminWrite.error, "organization users must not grant themselves platform-admin access");
  const selfActivate = await clientA.rpc("decide_organization_request", {
    p_actor_id: userA, p_request_id: crypto.randomUUID(), p_decision: "activate", p_reason: null,
  });
  assert(!!selfActivate.error, "regular users must not activate companies");

  const signupClient = createClient(url!, anonKey!, { auth: { autoRefreshToken: false, persistSession: false } });
  const directSignup = await signupClient.auth.signUp({
    email: `public-signup-${suffix}@example.test`,
    password: `Signup-test-${crypto.randomUUID()}-Aa9!`,
  });
  if (directSignup.data.user?.id) users.push(directSignup.data.user.id);
  assert(!!directSignup.error, "direct Supabase Auth signup must be disabled");

  const baseUrl = process.env.SMARTBOOK_BASE_URL;
  if (baseUrl) {
    const token = loginA.data.session!.access_token;
    const adminEndpoint = await fetch(`${baseUrl.replace(/\/$/, "")}/api/admin/invite`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ email: "forbidden@example.test", role: "admin" }) });
    assert(adminEndpoint.status === 403, "super-admin endpoints must reject a company-user JWT");
    const publicSignup = await fetch(`${baseUrl.replace(/\/$/, "")}/api/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    assert(publicSignup.status === 403, "public signup must be invitation-only");
  }
  console.log("RLS checks passed: cross-tenant read/write, pending/rejected/suspended read and write denial, direct Auth signup denial, public admin grant, and self-activation." + (baseUrl ? " API authorization checks passed." : " Set SMARTBOOK_BASE_URL to run API authorization checks."));
}

try { await main(); }
finally {
  for (const orgId of orgs) await admin.from("organizations").delete().eq("id", orgId);
  for (const userId of users) await admin.auth.admin.deleteUser(userId);
}
