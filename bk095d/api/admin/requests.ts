import { adminClient, bearerToken, requirePlatformAdmin } from "../_lib/supabase.js";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const token = bearerToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let actorId: string;
  try { actorId = await requirePlatformAdmin(token); }
  catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized";
    return Response.json({ error: message }, { status: message === "Forbidden" ? 403 : 401 });
  }
  void actorId;

  const { data, error } = await adminClient
    .from("organization_signup_requests")
    .select("id, organization_id, company_name, contact_name, email, phone, status, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) return Response.json({ error: "Could not load signup requests." }, { status: 500 });
  return Response.json({ requests: data });
}
