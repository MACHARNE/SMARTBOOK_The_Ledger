const id = number => `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
export async function mockAdminWorkspace(page, role = "super_admin", options = {}) {
  const user = { id: id(1), email: "paul@example.test", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-01T09:00:00Z" };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"), Buffer.from(JSON.stringify({ sub: user.id, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "fixture"].join(".");
  const companies = Array.from({ length: 43 }, (_, index) => {
    const status = ["pending", "active", "suspended", "rejected"][index % 4];
    return { id: id(index + 100), name: index === 0 ? "North Star Logistics" : index === 1 ? "Example Retail" : `Company ${String(index + 1).padStart(2, "0")}`, status, created_at: "2026-10-18T09:00:00Z", trial_unit: "month", trial_count: 1, trial_ends_at: new Date(Date.now() + 30 * 86400000).toISOString(), organization_signup_requests: [{ id: id(index + 200), status: status === "pending" ? "pending" : status === "rejected" ? "rejected" : "active", contact_name: `Owner ${index + 1}`, email: `owner${index + 1}@example.test`, phone: "+234 800 000 0000", created_at: "2026-10-18T09:00:00Z", reviewed_at: status === "pending" ? null : "2026-10-19T10:00:00Z", decision_reason: status === "rejected" ? "Company details could not be verified." : "" }] };
  });
  companies[1].trial_ends_at = new Date(Date.now() + 2 * 86400000).toISOString();
  companies[5].trial_ends_at = new Date(Date.now() + 3 * 86400000).toISOString();
  const administrators = [
    { user_id: id(1), email: "paul@example.test", role, status: "active", created_at: "2026-10-01T09:00:00Z", last_sign_in_at: "2026-10-20T08:00:00Z" },
    { user_id: id(2), email: "support@example.test", role: "admin", status: "active", created_at: "2026-10-02T09:00:00Z", last_sign_in_at: "2026-10-19T08:00:00Z" },
    { user_id: id(3), email: "operations@example.test", role: "super_admin", status: "setup_pending", created_at: "2026-10-03T09:00:00Z", last_sign_in_at: null },
  ];
  const activity = [
    { id: 1, action: "activate", company: "Example Retail", actor: "paul@example.test", createdAt: "2026-10-20T08:00:00Z", reason: "Owner details verified." },
    { id: 2, action: "platform_admin_invited", company: null, actor: "paul@example.test", createdAt: "2026-10-19T08:00:00Z", reason: "" },
    { id: 3, action: "suspend", company: "Company 03", actor: "paul@example.test", createdAt: "2026-10-18T08:00:00Z", reason: "Requested by the company owner." },
  ];
  const calls = [], posts = [], failures = new Map(); let release;
  await page.route("https://fonts.googleapis.com/**", route => route.abort());
  await page.route("https://fonts.gstatic.com/**", route => route.abort());
  await page.route("https://auth.example.test/**", route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith("/token") ? { access_token: token, refresh_token: "fixture", expires_in: 3600, token_type: "bearer", user } : path.endsWith("/logout") ? {} : user });
  });
  const paginate = (rows, params, key) => { const page = Number(params.get("page") || 0); return { [key]: rows.slice(page * 20, page * 20 + 20), total: rows.length, page, pageSize: 20 }; };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, params = url.searchParams;
    calls.push({ path, query: url.search, method: request.method() });
    if (request.method() === "POST") posts.push({ path, body: request.postDataJSON() });
    if (options.holdPath === path && request.method() === "POST") { await new Promise(resolve => { release = resolve; }); options.holdPath = null; }
    if (failures.has(path)) { const message = failures.get(path); failures.delete(path); return route.fulfill({ status: 503, json: { error: message } }); }
    if (path === "/api/config") return route.fulfill({ json: { url: "https://auth.example.test", anonKey: "fixture" } });
    if (path === "/api/session") return route.fulfill({ json: { kind: "platform_admin", role, userId: user.id } });
    if (path === "/api/admin/overview") return route.fulfill({ json: { summary: { totalCompanies: companies.length, activeCompanies: companies.filter(c => c.status === "active").length, pendingCompanies: companies.filter(c => c.status === "pending").length, pendingRequests: companies.filter(c => c.status === "pending").length, suspendedCompanies: companies.filter(c => c.status === "suspended").length, expiringTrials: 2, expiredTrials: 0, asOf: "2026-10-20T09:00:00Z" } } });
    if (path === "/api/admin/organizations") {
      const status = params.get("status"), now = Date.now();
      const rows = companies.filter(company => (!params.get("search") || company.name.toLowerCase().includes(params.get("search").toLowerCase())) &&
        (status === "trial_ending" ? company.status === "active" && new Date(company.trial_ends_at).getTime() >= now && new Date(company.trial_ends_at).getTime() < now + 7 * 86400000 : status === "trial_expired" ? company.status === "active" && new Date(company.trial_ends_at).getTime() < now : !status || status === "all" || company.status === status));
      return route.fulfill({ json: paginate(rows, params, "organizations") });
    }
    if (path === "/api/admin/requests") {
      const rows = companies.map(company => ({ ...company.organization_signup_requests[0], organization_id: company.id, company_name: company.name, organizations: { id: company.id, name: company.name, status: company.status } })).filter(row => (!params.get("search") || row.company_name.toLowerCase().includes(params.get("search").toLowerCase())) && (params.get("status") === "reviewed" ? row.status !== "pending" : !params.get("status") || params.get("status") === "all" || row.status === params.get("status")));
      return route.fulfill({ json: paginate(rows, params, "requests") });
    }
    if (path === "/api/admin/activity") return route.fulfill({ json: paginate(activity.filter(event => !params.get("action") || params.get("action") === "all" || event.action === params.get("action")), params, "activity") });
    if (path === "/api/admin/administrators") {
      if (!["admin", "super_admin"].includes(role)) return route.fulfill({ status: 403, json: { error: "Forbidden" } });
      if (request.method() === "POST") {
        const body = request.postDataJSON(), index = administrators.findIndex(a => a.user_id === body.userId);
        if (body.action === "revoke") administrators.splice(index, 1); else administrators[index].role = body.role;
        return route.fulfill({ json: { result: { changed: true } } });
      }
      return route.fulfill({ json: paginate(administrators.filter(a => (!params.get("search") || a.email.includes(params.get("search"))) && (params.get("status") === "all" || !params.get("status") || a.role === params.get("status"))), params, "administrators") });
    }
    if (path === "/api/admin/decision") {
      const body = request.postDataJSON(), company = companies.find(c => c.organization_signup_requests[0].id === body.requestId);
      company.status = ({ activate: "active", reject: "rejected", suspend: "suspended", reactivate: "active" })[body.decision];
      if (["activate", "reject"].includes(body.decision)) { company.organization_signup_requests[0].status = company.status; company.organization_signup_requests[0].reviewed_at = "2026-10-20T09:00:00Z"; company.organization_signup_requests[0].decision_reason = body.reason; }
      return route.fulfill({ json: { result: { status: company.status } } });
    }
    if (path === "/api/admin/org/provision-owner") {
      const body = request.postDataJSON(); companies.unshift({ id: id(800), name: body.companyName, status: "pending", created_at: "2026-10-20T09:00:00Z", organization_signup_requests: [{ id: id(801), status: "pending", contact_name: body.contactName, email: body.email, created_at: "2026-10-20T09:00:00Z" }] });
      return route.fulfill({ status: 201, json: { invited: true, status: "pending" } });
    }
    if (path === "/api/admin/invite" || path.endsWith("/set-trial")) return route.fulfill({ status: 201, json: { invited: true } });
    if (path.startsWith("/api/export/org/")) return route.fulfill({ contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: Buffer.from("PK-fixture-workbook") });
    return route.fulfill({ status: 404, json: { error: "Unexpected fixture route" } });
  });
  return { user, token, companies, administrators, calls, posts, failNext: (path, message = "The service is temporarily unavailable.") => failures.set(path, message), release: () => release?.(), goto: async (view = "overview") => {
    await page.goto(`/${role === "super_admin" ? "super-admin" : "admin"}/login#access_token=${token}&refresh_token=fixture`);
    const navigation = page.getByRole("navigation", { name: "Platform navigation" });
    await navigation.waitFor({ state: "visible" });
    if (view !== "overview") await navigation.getByRole("button", { name: ({ companies: "Companies", approvals: "Approvals", administrators: "Administrators", activity: "Activity log", access: "Your access" })[view], exact: true }).click();
  } };
}
