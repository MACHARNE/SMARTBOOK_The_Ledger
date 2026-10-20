import { adminClient, bearerToken, requireSuperAdmin } from "../_lib/supabase.js";
import { prepareInvitation, sendPreparedInvitation, invitationFailure } from "../_lib/invitations.js";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const token = bearerToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let actorId: string;
  try { actorId = await requireSuperAdmin(token); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Unauthorized" }, { status: 403 }); }
  let body: { email?: string; role?: string };
  try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const email = body.email?.trim().toLowerCase();
  const role = body.role || "admin";
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !["admin", "super_admin"].includes(role)) return Response.json({ error: "Valid email and admin role are required." }, { status: 400 });
  try {
    const user = await prepareInvitation(email);
    const assigned = await adminClient.rpc("provision_platform_admin", { p_actor_id: actorId, p_user_id: user.id, p_role: role });
    if (assigned.error) throw new Error("Could not assign admin access. Retry this invitation.");
    await sendPreparedInvitation(request, user);
  } catch (error) { return invitationFailure(error); }
  return Response.json({ invited: true, email, role }, { status: 201 });
}
