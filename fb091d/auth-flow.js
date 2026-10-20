// Explicitly consume email callbacks before deciding which screen to show.
// Admin-created invitations use the implicit flow and may open on another device.
export async function consumeAuthCallback(client, location, history) {
  const query = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const type = query.get("type") || hash.get("type");
  if (hash.has("access_token") || query.has("token_hash") || query.has("code")) history.replaceState({}, "", location.pathname);
  const error = query.get("error_description") || hash.get("error_description");
  if (error) {
    history.replaceState({}, "", location.pathname);
    throw new Error("This email link has expired or has already been used. Request a new invitation or use Forgot password.");
  }
  let session;
  if (hash.get("access_token") && hash.get("refresh_token")) {
    const result = await client.auth.setSession({ access_token: hash.get("access_token"), refresh_token: hash.get("refresh_token") });
    if (result.error) throw result.error;
    session = result.data.session;
  } else if (query.get("token_hash")) {
    if (!["invite", "recovery"].includes(type)) throw new Error("Unsupported email link. Request a new invitation.");
    const result = await client.auth.verifyOtp({ token_hash: query.get("token_hash"), type });
    if (result.error) throw result.error;
    session = result.data.session;
  } else if (query.get("code")) {
    const result = await client.auth.exchangeCodeForSession(query.get("code"));
    if (result.error) throw new Error("Open this link in the browser that requested it, or request a new password reset.");
    session = result.data.session;
  }
  if (!session) {
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    session = result.data.session;
  }
  return { session, invitation: type === "invite" || location.pathname === "/auth/invite", requiresPassword: type === "invite", recovery: type === "recovery" };
}

export function loginPortal(account) {
  return account?.kind === "platform_admin" ? (account.role === "super_admin" ? "/super-admin/login" : "/admin/login") : "/login";
}
