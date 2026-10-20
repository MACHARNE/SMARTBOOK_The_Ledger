import assert from "node:assert/strict";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "fixture-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service";
const originalFetch = globalThis.fetch;
const calls: Array<{ path: string; query: URLSearchParams; body: Record<string, unknown> | null }> = [];
const ids = { super: "40000000-0000-4000-8000-000000000001", admin: "40000000-0000-4000-8000-000000000002", member: "40000000-0000-4000-8000-000000000003" };
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input)); const headers = new Headers(init?.headers); const token = headers.get("authorization") || "";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  calls.push({ path: url.pathname, query: url.searchParams, body });
  if (url.pathname === "/auth/v1/user") return Response.json({ id: token.includes("super-token") ? ids.super : token.includes("admin-token") ? ids.admin : ids.member, app_metadata: {} });
  if (url.pathname === "/rest/v1/platform_admins") {
    const uid = url.searchParams.get("user_id");
    return uid === `eq.${ids.member}` ? Response.json(null) : Response.json({ user_id: uid?.slice(3), role: uid === `eq.${ids.super}` ? "super_admin" : "admin" });
  }
  if (url.pathname.endsWith("/admin_workspace_summary")) return Response.json({ totalCompanies: 3 });
  if (url.pathname.endsWith("/list_platform_administrators")) return Response.json({ administrators: [], total: 0, page: 0, pageSize: 20 });
  if (url.pathname.endsWith("/manage_platform_administrator")) return Response.json({ changed: true });
  if (url.pathname.endsWith("/decide_organization_request") || url.pathname.endsWith("/set_organization_trial")) return Response.json({ status: "active" });
  if (url.pathname.endsWith("/provision_company_owner")) return Response.json(ids.member);
  if (url.pathname.endsWith("/provision_platform_admin")) return Response.json(null);
  if (url.pathname.endsWith("/export_ledger_data")) return Response.json({ transactions: [] });
  if (url.pathname === "/auth/v1/admin/users" || url.pathname === "/auth/v1/invite") return Response.json({ id: ids.member, email: "invite@example.test", app_metadata: { force_password_reset: true } });
  if (url.pathname === "/rest/v1/organizations") return url.searchParams.has("id") ? Response.json({ name: "Test company" }) : Response.json([], { headers: { "Content-Range": "0-0/0" } });
  if (url.pathname === "/rest/v1/organization_signup_requests") return url.searchParams.has("organization_id") ? Response.json({ id: ids.member }) : Response.json([], { headers: { "Content-Range": "0-0/0" } });
  if (url.pathname === "/rest/v1/audit_events" && init?.method === "POST") return new Response(null, { status: 201 });
  if (url.pathname === "/rest/v1/audit_events") return Response.json([{ id: 1, action: "suspend", created_at: "2026-10-20T00:00:00Z", actor_user_id: null, organization_id: null, details: { reason: "Owner requested suspension", before: { amount: 999, private: "financial-data" } } }], { headers: { "Content-Range": "0-0/1" } });
  throw Error("Unexpected test request: " + url.pathname);
};
try {
  const { default: route } = await import("../api/_router.js");
  const request = (path: string, token?: string, body?: unknown) => new Request("https://app.example.test" + path, { method: body ? "POST" : "GET", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  for (const path of ["/api/admin/overview", "/api/admin/organizations", "/api/admin/requests", "/api/admin/administrators", "/api/admin/activity"]) {
    assert.equal((await route(request(path))).status, 401);
    assert.equal((await route(request(path, "member-token"))).status, 403);
  }
  assert.equal((await route(request("/api/admin/overview", "admin-token"))).status, 200);
  assert.equal((await route(request("/api/admin/administrators", "admin-token"))).status, 200);
  const writes: Array<[string, unknown, number]> = [
    ["/api/admin/administrators", { action: "revoke", userId: ids.super, reason: "Assignment ended" }, 200],
    ["/api/admin/invite", { email: "invite@example.test", role: "super_admin" }, 201],
    ["/api/admin/org/provision-owner", { companyName: "Test company", contactName: "Owner", email: "invite@example.test" }, 201],
    ["/api/admin/decision", { requestId: ids.member, decision: "activate" }, 200],
    [`/api/admin/org/${ids.member}/suspend`, { reason: "Owner requested pause" }, 200],
    [`/api/admin/org/${ids.member}/set-trial`, { unit: "week", count: 2 }, 200],
  ];
  for (const [path, body, status] of writes) {
    assert.equal((await route(request(path, "member-token", body))).status, 403, path);
    for (const token of ["admin-token", "super-token"]) assert.equal((await route(request(path, token, body))).status, status, path);
  }
  for (const token of ["admin-token", "super-token"]) {
    const exported = await route(request(`/api/export/org/${ids.member}.xlsx`, token)); assert.equal(exported.status, 200); assert.equal(exported.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }
  assert.equal((await route(request(`/api/export/org/${ids.member}.xlsx`, "member-token"))).status, 403);
  assert.equal((await route(request("/api/admin/administrators", "super-token"))).status, 200);
  const beforeInvalid = calls.filter(call => call.path.includes("/rpc/")).length;
  assert.equal((await route(request("/api/admin/administrators", "super-token", { action: "revoke", userId: ids.admin }))).status, 400);
  assert.equal((await route(request("/api/admin/administrators?status=viewer", "super-token"))).status, 400);
  assert.equal((await route(request("/api/admin/organizations?page=-1", "super-token"))).status, 400);
  assert.equal(calls.filter(call => call.path.includes("/rpc/")).length, beforeInvalid);
  const mutation = await route(request("/api/admin/administrators", "super-token", { action: "revoke", userId: ids.admin, reason: "Assignment ended" })); assert.equal(mutation.status, 200);
  assert.equal(calls.slice().reverse().find(call => call.path.endsWith("manage_platform_administrator"))?.body?.p_actor_id, ids.super);
  await route(request("/api/admin/organizations?page=1&status=active&search=100%25_", "admin-token"));
  const query = calls.slice().reverse().find(call => call.path === "/rest/v1/organizations")!.query;
  assert.equal(query.get("offset"), "20"); assert.equal(query.get("limit"), "20"); assert.equal(query.get("status"), "eq.active"); assert.equal(query.get("name"), "ilike.%100\\%\\_%");
  assert.equal((await route(request("/api/admin/organizations?status=trial_ending", "admin-token"))).status, 200);
  const trialQuery = calls.slice().reverse().find(call => call.path === "/rest/v1/organizations")!.query;
  assert.equal(trialQuery.get("status"), "eq.active");
  assert.equal(trialQuery.getAll("trial_ends_at").length, 2);
  const [start, end] = trialQuery.getAll("trial_ends_at");
  assert(start.startsWith("gte.")); assert(end.startsWith("lt."));
  assert.equal(new Date(end.slice(3)).getTime() - new Date(start.slice(4)).getTime(), 7 * 86400000);
  const activity = await route(request("/api/admin/activity", "admin-token")); const payload = JSON.stringify(await activity.json());
  assert(payload.includes("Owner requested suspension")); assert(!payload.includes("financial-data")); assert(!payload.includes('"before"'));
  assert.equal(activity.headers.get("cache-control"), "no-store");
  console.log("Passed: admin API authentication, role enforcement, actor identity, input validation, server pagination/literal filters, and financial audit redaction.");
} finally { globalThis.fetch = originalFetch; }
