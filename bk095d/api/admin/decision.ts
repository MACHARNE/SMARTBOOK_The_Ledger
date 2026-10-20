import { adminClient, bearerToken, requireSuperAdmin } from "../_lib/supabase.js";

type DecisionBody = { requestId?: string; decision?: "activate" | "reject" | "suspend" | "reactivate"; reason?: string };

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const token = bearerToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let actorId: string;
  try { actorId = await requireSuperAdmin(token); }
  catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized";
    return Response.json({ error: message }, { status: message === "Forbidden" ? 403 : 401 });
  }

  let body: DecisionBody;
  try { body = await request.json() as DecisionBody; }
  catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (!body.requestId || !["activate", "reject", "suspend", "reactivate"].includes(body.decision ?? "")) {
    return Response.json({ error: "Request ID and a valid decision are required." }, { status: 400 });
  }
  if (["reject", "suspend"].includes(body.decision!) && !body.reason?.trim()) {
    return Response.json({ error: "A reason is required for rejection or suspension." }, { status: 400 });
  }

  const { data, error } = await adminClient.rpc("decide_organization_request", {
    p_actor_id: actorId,
    p_request_id: body.requestId,
    p_decision: body.decision,
    p_reason: body.reason?.trim() || null,
  });
  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ result: data });
}
