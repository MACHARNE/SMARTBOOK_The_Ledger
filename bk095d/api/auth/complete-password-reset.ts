import { adminClient, bearerToken, userClient } from "../_lib/supabase.js";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const token = bearerToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userClientForToken = userClient(token);
  const { data: { user }, error } = await userClientForToken.auth.getUser();
  if (error || !user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { data: admin } = await adminClient.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!admin || user.app_metadata?.force_password_reset !== true) return Response.json({ error: "No forced admin password reset is pending." }, { status: 403 });
  const metadata = { ...user.app_metadata, force_password_reset: false };
  const { error: updateError } = await adminClient.auth.admin.updateUserById(user.id, { app_metadata: metadata });
  if (updateError) return Response.json({ error: "Password updated, but reset completion could not be recorded. Contact support." }, { status: 500 });
  return Response.json({ completed: true });
}
