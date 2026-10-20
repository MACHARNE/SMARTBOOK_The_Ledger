import assert from "node:assert/strict";
process.env.SUPABASE_URL="https://example.supabase.co";
process.env.SUPABASE_ANON_KEY="test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY="test-service-role-key";
delete process.env.AUTH_EMAIL_REDIRECT_URL;
const originalFetch=globalThis.fetch;
const originalError=console.error;
const logs: unknown[][]=[];
const calls: string[]=[];
let inviteStatus=500;
let existing=false;
const fixture={id:"invited-user",email:"invite@example.test",app_metadata:{force_password_reset:true}};
globalThis.fetch=async (input,init) => {
  const url=String(input); const method=init?.method || "GET";
  calls.push(`${method} ${new URL(url).pathname}`);
  if(url.includes("/auth/v1/user") && !url.includes("/admin/")) return Response.json({id:"actor",app_metadata:{}});
  if(url.includes("/rest/v1/platform_admins")) return Response.json({user_id:"actor",role:"super_admin"});
  if(url.includes("/auth/v1/admin/users")) {
    if(method==="POST") return existing ? Response.json({code:"email_exists",error_code:"email_exists",msg:"User already registered"},{status:422,headers:{"x-supabase-api-version":"2024-01-01"}}) : Response.json(fixture);
    return Response.json({users:[{...fixture,email_confirmed_at:"2026-10-18T00:00:00Z",app_metadata:{}}],total:1});
  }
  if(url.includes("/rest/v1/rpc/user_needs_password")) return Response.json(false);
  if(url.includes("/rest/v1/rpc/provision_platform_admin")) return Response.json(null);
  if(url.includes("/auth/v1/otp")) return Response.json({});
  if(url.includes("/auth/v1/invite")) {
    const body=JSON.parse(String(init?.body));
    assert.equal(body.email,"invite@example.test");
    assert(calls.some(call=>call.includes("provision_platform_admin")),"Role and audit must be committed before email");
    if(inviteStatus!==200) return Response.json({code:inviteStatus===500 ? "unexpected_failure":"over_email_send_rate_limit",msg:"Email service failure"},{status:inviteStatus});
    return Response.json(fixture);
  }
  throw Error(`Unexpected request: ${method} ${url}`);
};
console.error=(...args:unknown[])=>{logs.push(args);};
try {
  const {default:handler}=await import("../api/admin/invite.js");
  const request=(email:string)=>new Request("https://example.test/api/admin/invite",{method:"POST",headers:{Authorization:"Bearer test-token","Content-Type":"application/json"},body:JSON.stringify({email,role:"admin"})});
  const failed=await handler(request("invite@example.test"));
  assert.equal(failed.status,502); assert.match((await failed.json()).error,/retry/i);
  assert(!JSON.stringify(logs).includes("invite@example.test")); assert(!JSON.stringify(logs).includes("test-token"));
  assert(!calls.some(call=>call.startsWith("DELETE")),"Failed mail must not delete identities");
  inviteStatus=429; assert.equal((await handler(request("invite@example.test"))).status,429);
  inviteStatus=200; assert.equal((await handler(request("invite@example.test"))).status,201);
  existing=true; assert.equal((await handler(request("invite@example.test"))).status,201);
  assert(calls.some(call=>call.includes("/auth/v1/otp")),"Existing users should keep their password");
  const previous=calls.length; assert.equal((await handler(request("invalid"))).status,400);
  assert.equal(calls.slice(previous).filter(call=>call.includes("/auth/v1/admin/users")).length,0);
  console.log("Passed: invitation ordering, redirect, recoverable mail failures, rate limits, existing identities, and safe logs.");
} finally {globalThis.fetch=originalFetch;console.error=originalError;}
