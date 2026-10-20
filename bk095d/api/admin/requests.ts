import { adminClient } from "../_lib/supabase.js";
import { adminActor, adminFilters, searchPattern, adminJson, adminFailure } from "../_lib/admin-query.js";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return adminJson({ error: "Method not allowed" }, 405);
  try {
    await adminActor(request);
    const filters = adminFilters(request, ["all", "pending", "reviewed", "active", "rejected"]);
    let query = adminClient.from("organization_signup_requests").select("id,organization_id,company_name,contact_name,email,phone,status,created_at,reviewed_at,decision_reason,organizations(id,name,status)", { count: "exact" });
    if (filters.search) query = query.ilike("company_name", searchPattern(filters.search));
    if (filters.status === "reviewed") query = query.neq("status", "pending");
    else if (filters.status !== "all") query = query.eq("status", filters.status);
    const result = await query.order("created_at", { ascending: false }).order("id").range(filters.from, filters.to);
    if (result.error) throw new Error("Approval listing failed");
    return adminJson({ requests: result.data || [], total: result.count || 0, page: filters.page, pageSize: filters.pageSize });
  } catch (error) { return adminFailure(error); }
}
