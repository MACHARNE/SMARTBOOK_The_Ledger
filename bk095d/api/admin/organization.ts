import { adminClient, bearerToken, requirePlatformAdmin, requireSuperAdmin } from "../_lib/supabase.js";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const token = bearerToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let actorId: string;
  try { actorId = await requirePlatformAdmin(token); } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Unauthorized" }, { status: 403 }); }
  const path = new URL(request.url).pathname;
  const match = path.match(/\/api\/admin\/org\/([^/]+)\/([^/]+)$/);
  const orgId = path.endsWith("/provision-owner") ? "" : match?.[1];
  const action = path.endsWith("/provision-owner") ? "provision-owner" : match?.[2];
  if (!action) return Response.json({ error: "Organization and action are required." }, { status: 400 });
  let body: { reason?: string; unit?: string; count?: number; companyName?: string; contactName?: string; email?: string; phone?: string };
  try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (action === "provision-owner") {
    try { await requireSuperAdmin(token); } catch { return Response.json({ error: "Forbidden" }, { status: 403 }); }
    const companyName = body.companyName?.trim();
    const contactName = body.contactName?.trim();
    const email = body.email?.trim().toLowerCase();
    if (!companyName || !contactName || !email || companyName.length > 160 || contactName.length > 160 || email.length > 320 || (body.phone?.length ?? 0) > 40 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Response.json({ error: "Company, contact name, and a valid owner email are required." }, { status: 400 });
    const redirect = process.env.AUTH_EMAIL_REDIRECT_URL ? new URL(process.env.AUTH_EMAIL_REDIRECT_URL) : undefined;
    if (redirect) redirect.pathname = "/signup";
    const invitation = await adminClient.auth.admin.inviteUserByEmail(email, { redirectTo: redirect?.toString(), data: { contact_name: contactName } });
    if (invitation.error || !invitation.data.user) return Response.json({ error: invitation.error?.message || "Could not invite company owner." }, { status: 400 });
    const slugBase = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "company";
    const org = await adminClient.from("organizations").insert({ name: companyName, slug: `${slugBase}-${crypto.randomUUID().slice(0, 8)}`, status: "pending" }).select("id").single();
    if (org.error || !org.data) return Response.json({ error: "Owner invited, but company could not be created." }, { status: 500 });
    const member = await adminClient.from("organization_members").insert({ organization_id: org.data.id, user_id: invitation.data.user.id, role: "owner", status: "invited", invited_by: actorId });
    if (member.error) { await adminClient.from("organizations").delete().eq("id", org.data.id); return Response.json({ error: "Company could not be linked to its owner." }, { status: 500 }); }
    const signup = await adminClient.from("organization_signup_requests").insert({ organization_id: org.data.id, requester_user_id: invitation.data.user.id, company_name: companyName, contact_name: contactName, email, phone: body.phone?.trim() || null });
    if (signup.error) { await adminClient.from("organizations").delete().eq("id", org.data.id); return Response.json({ error: "Company approval request could not be created." }, { status: 500 }); }
    const audited = await adminClient.from("audit_events").insert({ organization_id: org.data.id, actor_user_id: actorId, action: "company_owner_invited", entity_type: "organization", entity_id: org.data.id, details: { email } });
    if (audited.error) { await adminClient.from("organizations").delete().eq("id", org.data.id); await adminClient.auth.admin.deleteUser(invitation.data.user.id); return Response.json({ error: "Could not audit the owner invitation; company provisioning was rolled back." }, { status: 500 }); }
    return Response.json({ organizationId: org.data.id, status: "pending", invited: true }, { status: 201 });
  }
  if (["activate", "reject", "suspend", "reactivate"].includes(action)) {
    if (["reject", "suspend"].includes(action) && !body.reason?.trim()) return Response.json({ error: "A reason is required." }, { status: 400 });
    const { data: req, error: reqError } = await adminClient.from("organization_signup_requests").select("id").eq("organization_id", orgId).maybeSingle();
    if (reqError || !req) return Response.json({ error: "Organization request not found." }, { status: 404 });
    const { data, error } = await adminClient.rpc("decide_organization_request", { p_actor_id: actorId, p_request_id: req.id, p_decision: action, p_reason: body.reason || null });
    if (error) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ result: data });
  }
  if (action === "set-trial") {
    try { await requireSuperAdmin(token); } catch { return Response.json({ error: "Forbidden" }, { status: 403 }); }
    const { data, error } = await adminClient.rpc("set_organization_trial", { p_actor_id: actorId, p_org_id: orgId, p_unit: body.unit, p_count: body.count });
    if (error) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ trial: data });
  }
  return Response.json({ error: "Unsupported organization action." }, { status: 404 });
}
