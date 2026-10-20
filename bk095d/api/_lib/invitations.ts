import { type User } from "@supabase/supabase-js";
import { adminClient } from "./supabase.js";
import { authRedirect } from "./auth-redirect.js";

export async function prepareInvitation(email: string): Promise<User> {
  const created = await adminClient.auth.admin.createUser({ email, email_confirm: false, app_metadata: { force_password_reset: true } });
  if (!created.error && created.data.user) return created.data.user;
  if (!created.error || !["email_exists", "user_already_exists"].includes(created.error.code || "")) throw created.error || new Error("Could not prepare invitation.");
  // Reuse identities on retry and when a person belongs to another company.
  for (let page = 1; ; page++) {
    const result = await adminClient.auth.admin.listUsers({ page, perPage: 100 });
    if (result.error) throw result.error;
    const user = result.data.users.find(user => user.email?.toLowerCase() === email);
    if (user) {
      const passwordState = await adminClient.rpc("user_needs_password", { p_user_id: user.id });
      if (passwordState.error) throw new Error("Could not check invitation setup. Retry later.");
      if (passwordState.data === true && user.app_metadata.force_password_reset !== true) {
        const updated = await adminClient.auth.admin.updateUserById(user.id, { app_metadata: { ...user.app_metadata, force_password_reset: true } });
        if (updated.error) throw updated.error;
        return updated.data.user;
      }
      return user;
    }
    if (result.data.users.length < 100) throw new Error("Existing invitation identity could not be found.");
  }
}

export async function sendPreparedInvitation(request: Request, user: User): Promise<void> {
  const email = user.email!;
  if (user.email_confirmed_at) {
    // Existing users keep their password; the link lets them accept membership.
    const result = await adminClient.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: authRedirect(request) } });
    if (result.error) throw result.error;
  } else {
    const result = await adminClient.auth.admin.inviteUserByEmail(email, { redirectTo: authRedirect(request) });
    if (result.error) throw result.error;
  }
}

export function invitationFailure(error: unknown): Response {
  const failure = error as { status?: number; code?: string; message?: string };
  const upstream = !failure.status || failure.status >= 500;
  console.error("Invitation could not be completed", { code: failure.code, status: failure.status });
  return Response.json({ error: upstream ? "Invitation could not be completed. The account setup is retained; retry to send the email." : failure.message || "Could not send invitation." }, { status: upstream ? 502 : failure.status === 429 ? 429 : 400 });
}
