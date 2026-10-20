import config from "./config.js";
import session from "./session.js";
import signup from "./signup.js";
import adminDecision from "./admin/decision.js";
import adminInvite from "./admin/invite.js";
import adminOrganizations from "./admin/organizations.js";
import adminProvisionInitial from "./admin/provision-initial.js";
import adminOrganization from "./admin/organization.js";
import adminRequests from "./admin/requests.js";
import adminOverview from "./admin/overview.js";
import adminAdministrators from "./admin/administrators.js";
import adminActivity from "./admin/activity.js";
import completePasswordReset from "./auth/complete-password-reset.js";
import acceptInvitation from "./org/accept-invitation.js";
import orgMembers from "./org/members.js";
import exportOrganization from "./export-org.js";

type Handler = (request: Request) => Response | Promise<Response>;

const routes: Record<string, Handler> = {
  "GET /api/config": config,
  "GET /api/session": session,
  "POST /api/signup": signup,
  "GET /api/admin/requests": adminRequests,
  "GET /api/admin/organizations": adminOrganizations,
  "GET /api/admin/overview": adminOverview,
  "GET /api/admin/administrators": adminAdministrators,
  "POST /api/admin/administrators": adminAdministrators,
  "GET /api/admin/activity": adminActivity,
  "POST /api/admin/decision": adminDecision,
  "POST /api/admin/invite": adminInvite,
  "POST /api/admin/provision-initial": adminProvisionInitial,
  "POST /api/admin/org/provision-owner": adminOrganization,
  "POST /api/auth/complete-password-reset": completePasswordReset,
  "POST /api/org/accept-invitation": acceptInvitation,
  "POST /api/org/invite": orgMembers,
  "POST /api/org/members": orgMembers,
  "GET /api/org/members": orgMembers,
};

export default async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const routePath = url.searchParams.get("route");
  if (routePath) {
    url.pathname = `/api/${routePath.replace(/^\/+/, "")}`;
    url.searchParams.delete("route");
  }
  const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
  const routedRequest = new Request(url, request);
  const exact = routes[`${request.method.toUpperCase()} ${normalizedPath}`];
  if (exact) return exact(routedRequest);

  if (request.method === "POST" && /^\/api\/admin\/org\/[^/]+\/(activate|reject|suspend|reactivate|set-trial)$/.test(normalizedPath)) {
    return adminOrganization(routedRequest);
  }
  if (request.method === "POST" && /^\/api\/org\/member\/[^/]+\/(revoke|change-role)$/.test(normalizedPath)) {
    return orgMembers(routedRequest);
  }
  if (request.method === "GET" && /^\/api\/export\/org\/[^/]+\.xlsx$/.test(normalizedPath)) {
    return exportOrganization(routedRequest);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
