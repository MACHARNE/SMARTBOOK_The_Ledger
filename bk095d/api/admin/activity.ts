import { adminClient } from "../_lib/supabase.js";
import { adminActor, adminFilters, AdminRequestError, adminJson, adminFailure } from "../_lib/admin-query.js";
const ACTIONS = ["activate", "reject", "suspend", "reactivate", "company_owner_invited", "platform_admin_invited", "platform_admin_role_changed", "platform_admin_revoked", "set_trial", "membership_invited", "membership_revoked", "member_role_changed", "organization_exported"];
export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return adminJson({ error: "Method not allowed" }, 405);
  try {
    await adminActor(request);
    const filters = adminFilters(request);
    const action = new URL(request.url).searchParams.get("action") || "all";
    if (action !== "all" && !ACTIONS.includes(action)) throw new AdminRequestError("Invalid activity filter.");
    const result = await adminClient.from("audit_events").select("id,organization_id,actor_user_id,entity_type,entity_id,action,details,created_at", { count: "exact" }).in("action", action === "all" ? ACTIONS : [action]).order("created_at", { ascending: false }).order("id", { ascending: false }).range(filters.from, filters.to);
    if (result.error) throw new Error("Platform activity listing failed");
    const rows = result.data || [];
    const companyId = (row: typeof rows[number]) => row.organization_id || (row.entity_type === "organization" ? row.entity_id : null);
    const organizationIds = [...new Set(rows.map(companyId).filter(Boolean))];
    const actorIds = [...new Set(rows.flatMap(row => [row.actor_user_id, row.entity_type === "platform_admin" ? row.entity_id : null]).filter(Boolean))];
    const [companies, actors] = await Promise.all([
      organizationIds.length ? adminClient.from("organizations").select("id,name").in("id", organizationIds) : Promise.resolve({ data: [], error: null }),
      Promise.all(actorIds.map(async id => { const result = await adminClient.auth.admin.getUserById(id); return [id, result.data.user?.email || "Platform operator"] as const; })),
    ]);
    if (companies.error) throw new Error("Activity company names could not be loaded");
    const names = new Map((companies.data || []).map(company => [company.id, company.name]));
    const actorNames = new Map(actors);
    const activity = rows.map(row => {
      const details = row.details as Record<string, unknown> | null;
      return { id: row.id, action: row.action, createdAt: row.created_at, actor: actorNames.get(row.actor_user_id) || "Platform operator", company: names.get(companyId(row)) || null,
        subject: row.entity_type === "platform_admin" ? actorNames.get(row.entity_id) || "Former administrator" : null,
        reason: typeof details?.reason === "string" ? details.reason.slice(0, 1000) : "" };
    });
    return adminJson({ activity, total: result.count || 0, page: filters.page, pageSize: filters.pageSize });
  } catch (error) { return adminFailure(error); }
}
