import { adminClient } from "../_lib/supabase.js";
import { adminActor, adminJson, adminFailure } from "../_lib/admin-query.js";
export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return adminJson({ error: "Method not allowed" }, 405);
  try {
    const actor = await adminActor(request);
    const result = await adminClient.rpc("admin_workspace_summary", { p_actor_id: actor });
    if (result.error) throw new Error("Workspace summary failed");
    return adminJson({ summary: result.data });
  } catch (error) { return adminFailure(error); }
}
