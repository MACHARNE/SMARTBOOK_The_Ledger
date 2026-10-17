import { adminClient, bearerToken, requireOrgOwner } from "../_lib/supabase.js";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const token = bearerToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { organizationId?: string; memberId?: string; email?: string; role?: string; action?: string };
  try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const path = new URL(request.url).pathname;
  const memberRoute = path.match(/\/api\/org\/member\/([^/]+)\/(revoke|change-role)$/);
  if (path.endsWith("/invite")) body.action = "invite";
  if (memberRoute) { body.memberId = memberRoute[1]; body.action = memberRoute[2]; }
  if (!body.organizationId) return Response.json({ error: "Organization ID is required." }, { status: 400 });
  let actorId: string;
  try { actorId = await requireOrgOwner(token, body.organizationId); } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Unauthorized" }, { status: 403 }); }
  if (body.action === "invite") {
    const email = body.email?.trim().toLowerCase();
    const role = body.role || "staff";
    if (!email || email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !["accountant", "staff", "viewer"].includes(role)) return Response.json({ error: "Valid email and member role are required." }, { status: 400 });
    const redirect = process.env.AUTH_EMAIL_REDIRECT_URL ? new URL(process.env.AUTH_EMAIL_REDIRECT_URL) : undefined;
    if (redirect) redirect.pathname = "/signup";
    const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, { redirectTo: redirect?.toString() });
    if (error || !data.user) return Response.json({ error: error?.message || "Could not invite member." }, { status: 400 });
    const saved = await adminClient.rpc("set_member_status", { p_actor_id: actorId, p_org_id: body.organizationId, p_user_id: data.user.id, p_status: "invited", p_role: role });
    if (saved.error) return Response.json({ error: saved.error.message }, { status: 400 });
    return Response.json({ invited: true, email, role }, { status: 201 });
  }
  if (!body.memberId || !["revoke", "change-role"].includes(body.action || "")) return Response.json({ error: "Member and supported action are required." }, { status: 400 });
  const result = await adminClient.rpc("set_member_status", { p_actor_id: actorId, p_org_id: body.organizationId, p_user_id: body.memberId, p_status: body.action === "revoke" ? "revoked" : "active", p_role: body.action === "change-role" ? body.role : null });
  if (result.error) return Response.json({ error: result.error.message }, { status: 400 });
  return Response.json({ result: result.data });
}
