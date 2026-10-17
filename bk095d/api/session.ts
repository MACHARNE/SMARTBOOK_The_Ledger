import { adminClient, bearerToken } from "./_lib/supabase.js";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const token = bearerToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { data: { user }, error: authError } = await adminClient.auth.getUser(token);
  if (authError || !user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { data: platformAdmin } = await adminClient.from("platform_admins").select("user_id,role").eq("user_id", user.id).maybeSingle();
  if (platformAdmin) return Response.json({ kind: "platform_admin", userId: user.id, role: platformAdmin.role });

  const { data: memberships, error } = await adminClient
    .from("organization_members")
    .select("organization_id, role, status, organizations(id, name, status, rejection_reason)")
    .eq("user_id", user.id);
  if (error) return Response.json({ error: "Could not check organization access." }, { status: 500 });
  const organizationStatus = (row: NonNullable<typeof memberships>[number]) => {
    const related = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
    return related?.status ?? "pending";
  };
  const membership = memberships?.find((row) => row.status === "active" && organizationStatus(row) === "active")
    || memberships?.find((row) => ["pending", "rejected", "suspended"].includes(organizationStatus(row)))
    || memberships?.[0];
  if (!membership) return Response.json({ kind: "company_user", status: "no_organization" });
  const org = Array.isArray(membership.organizations) ? membership.organizations[0] : membership.organizations;
  return Response.json({
    kind: "company_user",
    status: org?.status ?? "pending",
    memberStatus: membership.status,
    organizationId: membership.organization_id,
    organizationName: org?.name ?? "",
    rejectionReason: org?.rejection_reason ?? null,
    role: membership.role,
    userId: user.id,
  });
}
