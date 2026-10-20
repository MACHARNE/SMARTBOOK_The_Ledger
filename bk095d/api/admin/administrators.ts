import { adminClient } from "../_lib/supabase.js";
import { adminActor, adminFilters, AdminRequestError, adminJson, adminFailure } from "../_lib/admin-query.js";
export default async function handler(request: Request): Promise<Response> {
  if (!["GET", "POST"].includes(request.method)) return adminJson({ error: "Method not allowed" }, 405);
  try {
    const actor = await adminActor(request);
    if (request.method === "GET") {
      const filters = adminFilters(request, ["all", "admin", "super_admin"]);
      const result = await adminClient.rpc("list_platform_administrators", { p_actor_id: actor, p_page: filters.page, p_search: filters.search, p_role: filters.status });
      if (result.error) throw new Error("Administrator listing failed");
      return adminJson(result.data);
    }
    let body: { userId?: unknown; action?: unknown; role?: unknown; reason?: unknown };
    try { body = await request.json(); } catch { throw new AdminRequestError("A valid request is required."); }
    if (typeof body.userId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.userId) || !["change-role", "revoke"].includes(String(body.action))) throw new AdminRequestError("Choose an administrator and a valid action.");
    if (body.action === "change-role" && !["admin", "super_admin"].includes(String(body.role))) throw new AdminRequestError("Select a valid role.");
    if (body.reason != null && (typeof body.reason !== "string" || body.reason.length > 1000)) throw new AdminRequestError("Reason must be 1000 characters or fewer.");
    if (body.action === "revoke" && (typeof body.reason !== "string" || !body.reason.trim())) throw new AdminRequestError("A reason is required to remove access.");
    const result = await adminClient.rpc("manage_platform_administrator", { p_actor_id: actor, p_user_id: body.userId, p_action: body.action, p_role: body.action === "change-role" ? body.role : null, p_reason: typeof body.reason === "string" ? body.reason.trim() : null });
    if (result.error) throw new AdminRequestError(result.error.message);
    return adminJson({ result: result.data });
  } catch (error) { return adminFailure(error); }
}
