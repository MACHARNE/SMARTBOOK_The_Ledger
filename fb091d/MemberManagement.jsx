import React, { useCallback, useEffect, useState } from "react";

export default function MemberManagement({ organizationId }) {
  const [members, setMembers] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const request = useCallback(async (path, body) => {
    const { data } = await window.sbClient.auth.getSession();
    if (!data.session) throw new Error("Sign in again to manage members.");
    const response = await fetch(path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Member action failed.");
    return result;
  }, []);
  const load = useCallback(async () => {
    const result = await request(`/api/org/members?organizationId=${encodeURIComponent(organizationId)}&page=${page}`);
    setMembers(result.members); setHasMore(result.hasMore);
  }, [organizationId, page, request]);
  useEffect(() => { let cancelled = false; load().catch(e => { if (!cancelled) setError(e.message); }); return () => { cancelled = true; }; }, [load]);
  const act = async (body) => {
    if (busy) return false;
    setBusy(true); setError(""); setNotice("");
    try { await request("/api/org/members", { organizationId, ...body }); await load(); setNotice(body.action === "invite" ? "Invitation email sent." : "Member updated."); return true; }
    catch (error) { setError(error.message); return false; }
    finally { setBusy(false); }
  };
  return <section style={{ marginTop: 24 }}>
    <h3>Company members</h3>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
      <form onSubmit={async event => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); if (await act({ action: "invite", email: String(data.get("email")), role: String(data.get("role")) })) form.reset(); }}>
        <label>Email <input name="email" type="email" required maxLength={320} /></label>{" "}
        <label>Role <select name="role" defaultValue="staff"><option value="accountant">Accountant</option><option value="staff">Staff</option><option value="viewer">Viewer</option></select></label>{" "}
        <button>Invite member</button>
      </form>
      {members.map(member => <div key={member.user_id} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "12px 0", borderBottom: "1px solid #D8D2C2" }}>
        <span>{member.email} · {member.status}</span>
        {member.role === "owner" ? <strong>Owner</strong> : <>
          <label>Role <select aria-label={`Role for ${member.email}`} value={member.role} onChange={event => act({ action: "change-role", memberId: member.user_id, role: event.target.value })}><option value="accountant">Accountant</option><option value="staff">Staff</option><option value="viewer">Viewer</option></select></label>
          {member.status !== "revoked" && <button type="button" onClick={() => { if (window.confirm(`Revoke access for ${member.email}?`)) act({ action: "revoke", memberId: member.user_id }); }}>Revoke</button>}
          {member.status === "invited" && <button type="button" onClick={() => act({ action: "invite", email: member.email, role: member.role })}>Resend invitation</button>}
        </>}
      </div>)}
      <div style={{ display: "flex", gap: 12, marginTop: 12 }}><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><button type="button" disabled={!hasMore} onClick={() => setPage(page + 1)}>Next</button></div>
    </fieldset>
  </section>;
}
