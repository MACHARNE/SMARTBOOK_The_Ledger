import { adminClient, bearerToken, requireSuperAdmin } from "../_lib/supabase.js";

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
  const redirect = process.env.AUTH_EMAIL_REDIRECT_URL ? new URL(process.env.AUTH_EMAIL_REDIRECT_URL) : undefined;
  if (redirect) redirect.pathname = role === "super_admin" ? "/super-admin/login" : "/admin/login";
  const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, { redirectTo: redirect?.toString() });
  if (error || !data.user) return Response.json({ error: error?.message || "Could not invite admin." }, { status: 400 });
  const forcedReset = await adminClient.auth.admin.updateUserById(data.user.id, { app_metadata: { ...data.user.app_metadata, force_password_reset: true } });
  if (forcedReset.error) return Response.json({ error: "Invitation was sent but a required password reset could not be enforced." }, { status: 500 });
  const assigned = await adminClient.from("platform_admins").upsert({ user_id: data.user.id, role, created_by: actorId }, { onConflict: "user_id" });
  if (assigned.error) { await adminClient.auth.admin.deleteUser(data.user.id); return Response.json({ error: "Could not assign admin access; invitation was cancelled." }, { status: 500 }); }
  const audited = await adminClient.from("audit_events").insert({ actor_user_id: actorId, action: "platform_admin_invited", entity_type: "platform_admin", entity_id: data.user.id, details: { email, role } });
  if (audited.error) { await adminClient.from("platform_admins").delete().eq("user_id", data.user.id); await adminClient.auth.admin.deleteUser(data.user.id); return Response.json({ error: "Could not audit the invitation; admin provisioning was rolled back." }, { status: 500 }); }
  return Response.json({ invited: true, email, role }, { status: 201 });
}
