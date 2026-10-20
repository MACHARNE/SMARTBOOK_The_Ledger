import { adminClient } from "../_lib/supabase.js";
import { adminActor, adminFilters, searchPattern, adminJson, adminFailure } from "../_lib/admin-query.js";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return adminJson({ error: "Method not allowed" }, 405);
  try {
    await adminActor(request);
    const filters = adminFilters(request, ["all", "pending", "active", "suspended", "rejected", "trial_ending", "trial_expired"]);
    let query = adminClient.from("organizations").select("id,name,status,rejection_reason,created_at,trial_unit,trial_count,trial_started_at,trial_ends_at,organization_signup_requests(id,status,contact_name,email,phone,reviewed_at,decision_reason)", { count: "exact" });
    if (filters.search) query = query.ilike("name", searchPattern(filters.search));
    if (["trial_ending", "trial_expired"].includes(filters.status)) {
      const now = new Date();
      query = query.eq("status", "active");
      query = filters.status === "trial_ending"
        ? query.gte("trial_ends_at", now.toISOString()).lt("trial_ends_at", new Date(now.getTime() + 7 * 86400000).toISOString())
        : query.lt("trial_ends_at", now.toISOString());
    } else if (filters.status !== "all") query = query.eq("status", filters.status);
    const result = await query.order("created_at", { ascending: false }).order("id").range(filters.from, filters.to);
    if (result.error) throw new Error("Company listing failed");
    return adminJson({ organizations: result.data || [], total: result.count || 0, page: filters.page, pageSize: filters.pageSize });
  } catch (error) { return adminFailure(error); }
}
