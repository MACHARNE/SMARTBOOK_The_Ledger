import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey || !serviceRoleKey) {
  throw new Error("Supabase server environment is not configured.");
}

export const adminClient = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export function userClient(accessToken: string): SupabaseClient {
  return createClient(url!, publishableKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export async function requirePlatformAdmin(accessToken: string): Promise<string> {
  const client = userClient(accessToken);
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw new Error("Unauthorized");
  if (user.app_metadata?.force_password_reset === true) throw new Error("Password reset required");

  const { data: admin, error: adminError } = await adminClient
    .from("platform_admins")
    .select("user_id, role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (adminError || !admin) throw new Error("Forbidden");
  if (admin.role !== "super_admin" && admin.role !== "admin") throw new Error("Forbidden");
  return user.id;
}

export async function requireSuperAdmin(accessToken: string): Promise<string> {
  const actorId = await requirePlatformAdmin(accessToken);
  const { data } = await adminClient.from("platform_admins").select("role").eq("user_id", actorId).maybeSingle();
  if (data?.role !== "super_admin") throw new Error("Forbidden");
  return actorId;
}

export async function requireOrgOwner(accessToken: string, organizationId: string): Promise<string> {
  const client = userClient(accessToken);
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw new Error("Unauthorized");
  const { data, error: membershipError } = await adminClient.from("organization_members")
    .select("role,status,organizations(status)").eq("organization_id", organizationId).eq("user_id", user.id).maybeSingle();
  const org = Array.isArray(data?.organizations) ? data.organizations[0] : data?.organizations;
  if (membershipError || data?.role !== "owner" || data.status !== "active" || org?.status !== "active") throw new Error("Forbidden");
  return user.id;
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}
