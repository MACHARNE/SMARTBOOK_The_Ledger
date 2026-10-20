import { adminClient, bearerToken, requirePlatformAdmin } from "../_lib/supabase.js";
import { prepareInvitation, sendPreparedInvitation, invitationFailure } from "../_lib/invitations.js";

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
    const companyName = body.companyName?.trim();
    const contactName = body.contactName?.trim();
    const email = body.email?.trim().toLowerCase();
    if (!companyName || !contactName || !email || companyName.length > 160 || contactName.length > 160 || email.length > 320 || (body.phone?.length ?? 0) > 40 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Response.json({ error: "Company, contact name, and a valid owner email are required." }, { status: 400 });
    try {
      const user = await prepareInvitation(email);
      const result = await adminClient.rpc("provision_company_owner", { p_actor_id: actorId, p_user_id: user.id, p_company_name: companyName, p_contact_name: contactName, p_email: email, p_phone: body.phone?.trim() || null });
      if (result.error) throw new Error(result.error.message);
      await sendPreparedInvitation(request, user);
      return Response.json({ organizationId: result.data, status: "pending", invited: true }, { status: 201 });
    } catch (error) { return invitationFailure(error); }
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
    const { data, error } = await adminClient.rpc("set_organization_trial", { p_actor_id: actorId, p_org_id: orgId, p_unit: body.unit, p_count: body.count });
    if (error) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ trial: data });
  }
  return Response.json({ error: "Unsupported organization action." }, { status: 404 });
}
