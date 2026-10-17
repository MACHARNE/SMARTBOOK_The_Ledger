import { adminClient, bearerToken, requirePlatformAdmin } from "../_lib/supabase.js";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const token = bearerToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try { await requirePlatformAdmin(token); }
  catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized";
    return Response.json({ error: message }, { status: message === "Forbidden" ? 403 : 401 });
  }
  const { data, error } = await adminClient.from("organizations")
    .select("id, name, status, created_at, trial_unit, trial_count, trial_started_at, trial_ends_at, organization_signup_requests(id, status, contact_name, email)")
    .order("created_at", { ascending: false });
  if (error) return Response.json({ error: "Could not load companies." }, { status: 500 });
  return Response.json({ organizations: data || [] });
}
