import { adminClient, bearerToken, userClient } from "../_lib/supabase.js";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const token = bearerToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userClientForToken = userClient(token);
  const { data: { user }, error } = await userClientForToken.auth.getUser();
  if (error || !user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.force_password_reset !== true) return Response.json({ error: "No required password setup is pending." }, { status: 403 });
  let body: { password?: unknown };
  try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) return Response.json({ error: "Use a password between 12 and 128 characters." }, { status: 400 });
  const metadata = { ...user.app_metadata, force_password_reset: false };
  // One Auth update changes the verified user's password and setup flag together.
  const { error: updateError } = await adminClient.auth.admin.updateUserById(user.id, { password: body.password, app_metadata: metadata });
  if (updateError) return Response.json({ error: "Your password could not be saved. Retry or contact support." }, { status: 502 });
  return Response.json({ completed: true });
}
