import { bearerToken, requirePlatformAdmin, requireSuperAdmin } from "./supabase.js";
export class AdminRequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export async function adminActor(request: Request, superOnly = false): Promise<string> {
  const token = bearerToken(request);
  if (!token) throw new AdminRequestError("Sign in to continue.", 401);
  try { return await (superOnly ? requireSuperAdmin(token) : requirePlatformAdmin(token)); }
  catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized";
    throw new AdminRequestError(message === "Forbidden" ? "Your account does not have permission for this action." : "Your session needs to be renewed. Sign in again.", message === "Forbidden" ? 403 : 401);
  }
}
export function adminFilters(request: Request, statuses: readonly string[] = []) {
  const params = new URL(request.url).searchParams;
  const page = Number(params.get("page") || "0");
  const search = (params.get("search") || "").trim();
  const status = params.get("status") || "all";
  if (!Number.isInteger(page) || page < 0 || page > 10000 || search.length > 100 || (statuses.length > 0 && !statuses.includes(status))) throw new AdminRequestError("Invalid list filters.");
  return { page, search, status, pageSize: 20, from: page * 20, to: page * 20 + 19 };
}
export function searchPattern(search: string): string { return `%${search.replace(/[\\%_]/g, character => `\\${character}`)}%`; }
export function adminJson(value: unknown, status = 200) { return Response.json(value, { status, headers: { "Cache-Control": "no-store" } }); }
export function adminFailure(error: unknown) {
  if (error instanceof AdminRequestError) return adminJson({ error: error.message }, error.status);
  console.error("Admin workspace request failed", { message: error instanceof Error ? error.message : "Unexpected error" });
  return adminJson({ error: "The request could not be completed. Please try again." }, 500);
}
