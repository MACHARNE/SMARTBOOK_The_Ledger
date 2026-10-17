import { adminClient, bearerToken, userClient } from "../_lib/supabase.js";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const token = bearerToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const client = userClient(token);
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const pending = await adminClient.from("organization_members").select("organization_id,role,status,organizations(status)").eq("user_id", user.id).in("status", ["invited", "active"]);
  if (pending.error || !pending.data?.length) return Response.json({ error: "No pending organization invitation was found." }, { status: 404 });
  const accepted = [];
  for (const row of pending.data) {
    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
    if (org?.status !== "active") continue;
    const { data: activated, error: activationError } = await adminClient.rpc("accept_member_invitation", { p_user_id: user.id, p_org_id: row.organization_id });
    if (activationError || !activated) return Response.json({ error: activationError?.message || "Could not activate membership." }, { status: 500 });
    accepted.push(row.organization_id);
  }
  return Response.json({ accepted, pendingActivation: accepted.length === 0 });
}
