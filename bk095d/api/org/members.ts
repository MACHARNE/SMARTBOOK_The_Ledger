import { adminClient, bearerToken, requireOrgOwner } from "../_lib/supabase.js";
import { prepareInvitation, sendPreparedInvitation, invitationFailure } from "../_lib/invitations.js";

export default async function handler(request: Request): Promise<Response> {
  if (!["GET", "POST"].includes(request.method)) return Response.json({ error: "Method not allowed" }, { status: 405 });
  const token = bearerToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (request.method === "GET") {
    const orgId = new URL(request.url).searchParams.get("organizationId");
    if (!orgId) return Response.json({ error: "Organization ID is required." }, { status: 400 });
    try { await requireOrgOwner(token, orgId); } catch { return Response.json({ error: "Forbidden" }, { status: 403 }); }
    const page = Math.max(0, Number(new URL(request.url).searchParams.get("page")) || 0);
    const result = await adminClient.from("organization_members").select("user_id,role,status,created_at").eq("organization_id", orgId).order("created_at").order("user_id").range(page * 50, page * 50 + 50);
    if (result.error) return Response.json({ error: "Could not load company members." }, { status: 500 });
    const members = await Promise.all((result.data || []).slice(0, 50).map(async member => {
      const user = await adminClient.auth.admin.getUserById(member.user_id);
      if (user.error) throw new Error("Could not load member identity.");
      return { ...member, email: user.data.user.email };
    }));
    return Response.json({ members, hasMore: (result.data?.length || 0) > 50 }, { headers: { "Cache-Control": "no-store" } });
  }
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
    try {
      const user = await prepareInvitation(email);
      const saved = await adminClient.rpc("set_member_status", { p_actor_id: actorId, p_org_id: body.organizationId, p_user_id: user.id, p_status: "invited", p_role: role });
      if (saved.error) throw new Error(saved.error.message);
      await sendPreparedInvitation(request, user);
      return Response.json({ invited: true, email, role }, { status: 201 });
    } catch (error) { return invitationFailure(error); }
  }

  if (!body.memberId || !["revoke", "change-role"].includes(body.action || "")) return Response.json({ error: "Member and supported action are required." }, { status: 400 });
  const current = await adminClient.from("organization_members").select("status").eq("organization_id", body.organizationId).eq("user_id", body.memberId).maybeSingle();
  if (current.error || !current.data) return Response.json({ error: "Member not found." }, { status: 404 });
  if (body.action === "change-role" && current.data.status === "revoked") return Response.json({ error: "Invite the revoked member again before changing their role." }, { status: 400 });
  const result = await adminClient.rpc("set_member_status", { p_actor_id: actorId, p_org_id: body.organizationId, p_user_id: body.memberId, p_status: body.action === "revoke" ? "revoked" : current.data.status, p_role: body.action === "change-role" ? body.role : null });
  if (result.error) return Response.json({ error: result.error.message }, { status: 400 });
  return Response.json({ result: result.data });
}
