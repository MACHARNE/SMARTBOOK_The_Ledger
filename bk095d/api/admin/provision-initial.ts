import { adminClient } from "../_lib/supabase.js";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const secret = process.env.INITIAL_ADMIN_PROVISION_SECRET;
  if (!secret || request.headers.get("x-initial-admin-secret") !== secret) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_TEMP_PASSWORD;
  if (!email || !password || password.length < 16) return Response.json({ error: "Initial admin provisioning is not configured." }, { status: 503 });
  const { count, error: countError } = await adminClient.from("platform_admins").select("user_id", { count: "exact", head: true });
  if (countError) return Response.json({ error: "Could not inspect platform admin setup." }, { status: 500 });
  if ((count || 0) > 0) return Response.json({ error: "Initial platform admin has already been provisioned." }, { status: 409 });
  const { data, error } = await adminClient.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { force_password_reset: true } });
  if (error || !data.user) return Response.json({ error: error?.message || "Could not create initial admin." }, { status: 400 });
  const inserted = await adminClient.from("platform_admins").insert({ user_id: data.user.id, role: "super_admin" });
  if (inserted.error) {
    await adminClient.auth.admin.deleteUser(data.user.id);
    return Response.json({ error: "Could not assign initial admin role." }, { status: 500 });
  }
  const audited = await adminClient.from("audit_events").insert({ actor_user_id: data.user.id, action: "initial_platform_admin_provisioned", entity_type: "platform_admin", entity_id: data.user.id });
  if (audited.error) {
    await adminClient.from("platform_admins").delete().eq("user_id", data.user.id);
    await adminClient.auth.admin.deleteUser(data.user.id);
    return Response.json({ error: "Initial admin was created but could not be audited; provisioning was rolled back." }, { status: 500 });
  }
  return Response.json({ provisioned: true, userId: data.user.id, email, passwordResetRequired: true }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
