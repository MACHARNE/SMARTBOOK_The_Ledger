import React, { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
import { consumeAuthCallback, loginPortal } from "./auth-flow.js";
import MeatShareLedger from "./Ledger.jsx";
import AdminDashboard from "./AdminDashboard.jsx";

export default function App() {
  const [client, setClient] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [passwordResetRequired, setPasswordResetRequired] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [invitationReady, setInvitationReady] = useState(false);
  const [invitationNeedsPassword, setInvitationNeedsPassword] = useState(false);
  const path = window.location.pathname.replace(/\/$/, "") || "/login";
  const adminRoute = path === "/admin/login";
  const superAdminRoute = path === "/super-admin/login";
  const platformAdminRoute = adminRoute || superAdminRoute;
  const expectedAdminRole = superAdminRoute ? "super_admin" : "admin";
  const signupRoute = path === "/signup" || path === "/auth/invite";

  const loadAccount = async (supabase, token) => {
    const { data: identity } = await supabase.auth.getUser(token);
    setPasswordResetRequired(identity.user?.app_metadata?.force_password_reset === true);
    if (signupRoute) setInvitationReady(!!identity.user);
    const response = await fetch("/api/session", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not check account status.");
    result.email = identity.user?.email || "";
    if (result.kind === "company_user" && result.status === "active" && result.memberStatus === "active") {
      if (window.activeOrganizationId !== result.organizationId || !window.storage) {
        window.activeOrganizationId = result.organizationId;
        window.storage = window.makeSupabaseStorage();
      }
      window.activeUserId = result.userId;
      setStatus(result);
      return result;
    }
    window.activeOrganizationId = null;
    window.activeUserId = null;
    window.storage = null;
    setStatus(result);
    return result;
  };

  useEffect(() => {
    (async () => {
      const query = new URLSearchParams(window.location.search);
      if (query.get("welcome") === "1") setNotice(platformAdminRoute ? "Your account is ready. Sign in to your platform workspace." : "Your invitation is accepted. Sign in to continue. Company access remains subject to activation.");
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      if (query.get("type") === "recovery" || hash.get("type") === "recovery") setPasswordRecovery(true);
      const authError = query.get("error_description") || hash.get("error_description");
      if (authError) setError(authError.replace(/\+/g, " "));
      try {
        const configResponse = await fetch("/api/config", { cache: "no-store" });
        const config = await configResponse.json();
        if (!configResponse.ok) throw new Error(config.error || "Authentication is not configured.");
        const supabase = createClient(config.url, config.anonKey, { auth: { detectSessionInUrl: false, flowType: "implicit" } });
        supabase.auth.onAuthStateChange((event) => { if (event === "PASSWORD_RECOVERY") setPasswordRecovery(true); });
        window.sbClient = supabase;
        setClient(supabase);
        const callback = await consumeAuthCallback(supabase, window.location, window.history);
        setInvitationNeedsPassword(callback.requiresPassword);
        if (callback.recovery) setPasswordRecovery(true);
        if (callback.invitation && callback.session && !signupRoute) {
          window.location.replace(`/auth/invite${callback.requiresPassword ? "?type=invite" : ""}`);
          return;
        }
        const data = { session: callback.session };
        if (data.session) {
          await loadAccount(supabase, data.session.access_token);
        }
      } catch (e) { setError(e.message || "Could not connect to the service."); }
      finally { setBusy(false); }
    })();
  }, []);

  useEffect(() => {
    if (!client || !status?.organizationId) return;
    const refreshAccess = async () => {
      const { data } = await client.auth.getSession();
      if (!data.session) { setStatus(null); window.storage = null; return; }
      try { await loadAccount(client, data.session.access_token); }
      catch (e) { setError(e.message || "Could not refresh company access."); }
    };
    const timer = window.setInterval(refreshAccess, 30000);
    window.addEventListener("focus", refreshAccess);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refreshAccess); };
  }, [client, status?.organizationId]);

  const signOut = async () => {
    if (client) await client.auth.signOut();
    window.storage = null;
    window.activeOrganizationId = null;
    window.activeUserId = null;
    setStatus(null);
    setPasswordResetRequired(false);
    setInvitationReady(false);
    setRequests([]);
    setOrganizations([]);
    setNotice("");
  };

  const submitLogin = async (email, password) => {
    setError("");
    setBusy(true);
    try {
      const { data, error: loginError } = await client.auth.signInWithPassword({ email, password });
      if (loginError || !data.session) throw loginError || new Error("Login failed.");
      if (data.user?.app_metadata?.force_password_reset === true) setPasswordResetRequired(true);
      const account = await loadAccount(client, data.session.access_token);
      if (platformAdminRoute) {
        if (account.kind !== "platform_admin" || account.role !== expectedAdminRole) {
          await signOut();
          throw new Error(`This account is not authorized for the ${superAdminRoute ? "super-admin" : "platform-admin"} portal.`);
        }
      } else if (account.kind === "platform_admin") {
        setNotice(`Platform account verified. Sign in at ${account.role === "super_admin" ? "/super-admin/login" : "/admin/login"}.`);
      }
    } catch (e) { setError(e.message || "Login failed."); }
    finally { setBusy(false); }
  };

  const acceptInvitation = async (password) => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const { data: sessionData } = await client.auth.getSession();
      if (!sessionData.session) throw new Error("Your invitation has expired. Request a new link.");
      const token = sessionData.session.access_token;
      if (passwordResetRequired) {
        const response = await fetch("/api/auth/complete-password-reset", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not create your password.");
      } else if (invitationNeedsPassword) {
        const { error: updateError } = await client.auth.updateUser({ password });
        if (updateError) throw updateError;
      }
      if (status?.kind !== "platform_admin") {
        const response = await fetch("/api/org/accept-invitation", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not accept invitation.");
      }
      const portal = loginPortal(status);
      await client.auth.signOut();
      window.location.replace(`${portal}?welcome=1`);
    } catch (e) { setError(e.message || "Could not accept invitation."); }
    finally { setBusy(false); }
  };

  const requestPasswordReset = async (email) => {
    setError(""); setNotice(""); setBusy(true);
    try {
      // Use the single redirect path already shared by all account types. The
      // role is resolved from the verified session after the password changes.
      const { error: resetError } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/login` });
      if (resetError) throw resetError;
      setNotice("If the email is registered, a password reset link has been sent.");
    } catch (e) { setError(e.message || "Could not request a password reset."); }
    finally { setBusy(false); }
  };

  const changePassword = async (password) => {
    setBusy(true); setError("");
    try {
      if (!passwordResetRequired) {
        const { error: updateError } = await client.auth.updateUser({ password });
        if (updateError) throw updateError;
      }
      const { data: sessionData } = await client.auth.getSession();
      let session = sessionData.session;
      if (!session) throw new Error("Your password was changed, but the recovery session has expired. Sign in with your new password.");
      if (passwordResetRequired) {
        const response = await fetch("/api/auth/complete-password-reset", { method: "POST", headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not complete the required password reset.");
      }
      const portal = loginPortal(status);
      await client.auth.signOut();
      window.location.replace(`${portal}?welcome=1`);
    } catch (e) { setError(e.message || "Could not update password."); }
    finally { setBusy(false); }
  };

  const center = { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F6F3EC", fontFamily: "'Inter', sans-serif", color: "#21281F", padding: 24 };
  const card = { width: "100%", maxWidth: platformAdminRoute ? 640 : 380, background: "#fff", border: "1px solid #D8D2C2", borderRadius: 12, padding: 28 };
  const inputStyle = { display: "block", width: "100%", marginTop: 4, padding: "10px", borderRadius: 8, border: "1px solid #D8D2C2", fontSize: 14, boxSizing: "border-box" };
  const buttonStyle = { marginTop: 4, padding: "11px 14px", borderRadius: 8, border: "none", background: "#21281F", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" };

  if (busy && !client) return <div style={center}><div style={card}>Connecting to Smart Book…</div></div>;
  if (!client) return <div style={center}><div style={card}><div style={{ color: "#A6491E" }}>{error}</div></div></div>;

  if (!signupRoute && (passwordResetRequired || passwordRecovery)) return <div style={center}><form style={card} onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); changePassword(String(f.get("newPassword"))); }}>
    <div style={{ fontSize: 11, letterSpacing: "0.18em", color: "#C9A227", fontWeight: 700 }}>SMART BOOK</div><h2 style={{ fontFamily: "'Fraunces', serif" }}>Set a new password</h2>
    <label style={{ display: "block", fontSize: 12, color: "#7A7566", fontWeight: 600 }}>New password<input name="newPassword" type="password" minLength={12} required style={inputStyle} /></label>
    {error && <div style={{ color: "#A6491E", marginTop: 10 }}>{error}</div>}<button disabled={busy} style={{ ...buttonStyle, width: "100%", marginTop: 14 }}>Update password</button>
  </form></div>;

  if (status?.kind === "platform_admin" && platformAdminRoute && status.role === expectedAdminRole) {
    return <AdminDashboard client={client} account={status} onSignOut={signOut} />;
  }

  if (!signupRoute && status?.kind === "platform_admin" && (!platformAdminRoute || status.role !== expectedAdminRole)) {
    const correctPortal = status.role === "super_admin" ? "/super-admin/login" : "/admin/login";
    return <div style={center}><div style={card}><div style={{ fontSize: 11, letterSpacing: "0.18em", color: "#C9A227", fontWeight: 700 }}>SMART BOOK</div><h2 style={{ fontFamily: "'Fraunces', serif", margin: "4px 0 12px" }}>Use your assigned portal</h2><div style={{ background: "#EFEBE0", padding: 14, borderRadius: 8, fontSize: 14, lineHeight: 1.5 }}>This account is assigned to a different Smart Book login portal.</div><a href={correctPortal} style={{ ...buttonStyle, display: "inline-block", textDecoration: "none", marginTop: 16 }}>Continue to your portal</a><button onClick={signOut} style={{ ...buttonStyle, display: "block", marginTop: 12 }}>Log Out</button></div></div>;
  }

  if (platformAdminRoute && status?.kind === "company_user") {
    return <div style={center}><div style={card}><h2>Use your company portal</h2><p>This account belongs to the company user portal.</p><a href="/login" style={{ ...buttonStyle, display: "inline-block", textDecoration: "none" }}>Continue to company login</a><button onClick={signOut} style={{ ...buttonStyle, display: "block", marginTop: 12 }}>Log Out</button></div></div>;
  }

  if (!signupRoute && status?.kind === "company_user" && !(status.status === "active" && status.memberStatus === "active")) {
    const label = status.status === "pending" ? "Your company is awaiting administrator approval. Ledger access is disabled." : status.status === "rejected" ? `This company request was rejected${status.rejectionReason ? `: ${status.rejectionReason}` : ". Contact Smart Book support for details."}` : status.status === "suspended" ? "This company account is suspended. Ledger access is disabled." : status.status === "no_organization" ? "This account is not linked to a company yet." : status.memberStatus === "invited" ? "Accept the company invitation from your email to activate your access." : "Your account does not currently have active company access.";
    return <div style={center}><div style={card}><div style={{ fontSize: 11, letterSpacing: "0.18em", color: "#C9A227", fontWeight: 700 }}>SMART BOOK</div><h2 style={{ fontFamily: "'Fraunces', serif", margin: "4px 0 12px" }}>Account status</h2><div style={{ background: "#EFEBE0", padding: 14, borderRadius: 8, fontSize: 14, lineHeight: 1.5 }}>{label}</div><button onClick={signOut} style={{ ...buttonStyle, marginTop: 16 }}>Log Out</button></div></div>;
  }

  if (signupRoute) return <div style={center}><form style={card} onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); acceptInvitation(String(f.get("password"))); }}>
    <div style={{ textAlign: "center", marginBottom: 20 }}><div style={{ fontSize: 11, letterSpacing: "0.18em", color: "#C9A227", fontWeight: 700 }}>SMART BOOK</div><div style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 700 }}>Accept invitation</div></div>
    {!invitationReady ? <div style={{ color: "#7A7566", fontSize: 14, lineHeight: 1.5 }}>{busy ? "Checking your invitation…" : "Access is invitation-only. Open the invitation link sent to your email to continue."}</div> : (passwordResetRequired || invitationNeedsPassword) ? <label style={{ display: "block", fontSize: 12, color: "#7A7566", fontWeight: 600 }}>Create password (12 characters minimum)<input name="password" type="password" minLength={12} required style={inputStyle} /></label> : <p>Accept your invitation using your existing account. Your password stays the same.</p>}
    {error && <div style={{ color: "#A6491E", marginTop: 10, fontSize: 13 }}>{error}</div>}{notice && <div style={{ color: "#2F5233", marginTop: 10, fontSize: 13 }}>{notice}</div>}
    {invitationReady && <button disabled={busy} style={{ ...buttonStyle, width: "100%", marginTop: 14 }}>{busy ? "Accepting…" : (passwordResetRequired || invitationNeedsPassword) ? "Set password and accept" : "Accept invitation"}</button>}<div style={{ fontSize: 12, marginTop: 14 }}><a href="/login">Already registered? Log in</a></div>
  </form></div>;

  if (status?.kind === "company_user" && status.status === "active" && status.memberStatus === "active") {
    return <div><div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 16px", background: "#21281F", color: "#fff", fontSize: 12 }}><span>{status.organizationName}</span><button onClick={signOut} style={{ background: "transparent", border: "1px solid #545C51", color: "#fff", borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>Log Out</button></div><MeatShareLedger key={status.organizationId} orgName={status.organizationName} role={status.role} /></div>;
  }

  return <div style={center}><form style={card} onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); if (resetMode) requestPasswordReset(String(f.get("email"))); else submitLogin(String(f.get("email")), String(f.get("password"))); }}>
    <div style={{ textAlign: "center", marginBottom: 20 }}><div style={{ fontSize: 11, letterSpacing: "0.18em", color: "#C9A227", fontWeight: 700 }}>SMART BOOK</div><div style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 700, marginTop: 2 }}>{superAdminRoute ? "Super Admin" : adminRoute ? "Platform Admin" : "The Ledger"}</div></div>
    <label style={{ display: "block", fontSize: 12, color: "#7A7566", fontWeight: 600 }}>Email<input name="email" type="email" required style={inputStyle} /></label>
    {!resetMode && <label style={{ display: "block", fontSize: 12, color: "#7A7566", fontWeight: 600, marginTop: 12 }}>Password<input name="password" type="password" required style={inputStyle} /></label>}
    {error && <div style={{ color: "#A6491E", fontSize: 12, marginTop: 10 }}>{error}</div>}{notice && <div style={{ color: "#2F5233", fontSize: 12, marginTop: 10 }}>{notice}</div>}
    <button disabled={busy} style={{ ...buttonStyle, width: "100%", marginTop: 14 }}>{busy ? "Checking…" : resetMode ? "Send reset link" : "Log In"}</button>
    <div style={{ fontSize: 12, marginTop: 12 }}><button type="button" onClick={() => { setResetMode(!resetMode); setError(""); setNotice(""); }} style={{ border: 0, background: "none", color: "#7A7566", padding: 0, cursor: "pointer", textDecoration: "underline" }}>{resetMode ? "Back to login" : "Forgot password?"}</button></div>
  </form></div>;
}
