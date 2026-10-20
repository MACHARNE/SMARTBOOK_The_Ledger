import assert from "node:assert/strict";
process.env.SUPABASE_URL="https://example.supabase.co";
process.env.SUPABASE_ANON_KEY="test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY="test-service-key";
const original=globalThis.fetch;
let updates=0;
let fail=false;
globalThis.fetch=async (input,init) => {
  const url=String(input);
  if(url.endsWith("/auth/v1/user")) return Response.json({id:"10000000-0000-4000-8000-000000000001",app_metadata:{force_password_reset:true,other:"preserved"}});
  if(url.endsWith("/auth/v1/admin/users/10000000-0000-4000-8000-000000000001")) {
    updates++;
    const body=JSON.parse(String(init?.body));
    assert.equal(body.password,"A-strong-fixture-password-123!");
    assert.equal(body.app_metadata.force_password_reset,false);
    assert.equal(body.app_metadata.other,"preserved");
    return fail ? Response.json({msg:"fixture update failure"},{status:500}) : Response.json({id:"10000000-0000-4000-8000-000000000001",app_metadata:body.app_metadata});
  }
  throw Error(`Unexpected request: ${url}`);
};
try {
  const {default:handler}=await import("../api/auth/complete-password-reset.js");
  const request=(body:unknown)=>new Request("https://example.test/api/auth/complete-password-reset",{method:"POST",headers:{Authorization:"Bearer verified-token","Content-Type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await handler(request({}))).status,400);
  assert.equal((await handler(request({password:"short"}))).status,400);
  assert.equal(updates,0,"Cannot clear setup without setting a valid password");
  assert.equal((await handler(request({password:"A-strong-fixture-password-123!",userId:"another-user"}))).status,200);
  fail=true;
  assert.equal((await handler(request({password:"A-strong-fixture-password-123!"}))).status,502);
  console.log("Passed: password setup requires a password, updates only the authenticated identity, preserves metadata, and keeps failures recoverable.");
} finally {globalThis.fetch=original;}
