import { createClient } from "@supabase/supabase-js";
const url=process.env.SUPABASE_URL;
const anon=process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const secret=process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
if(!url || !anon || !secret) throw new Error("Configure staging Supabase credentials first.");
const ref=new URL(url).hostname.split(".")[0];
if(ref==="twhnwowshcowqldpzwbo" || !process.env.SMARTBOOK_STAGING_PROJECT_REF || process.env.SMARTBOOK_STAGING_PROJECT_REF!==ref) throw new Error("RLS fixtures run only in an explicitly configured staging project. Production is always refused.");
const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
const password=`Fixture-${crypto.randomUUID()}-Aa9!`;
const suffix=crypto.randomUUID();
const users:string[]=[];
const orgs:string[]=[];
const assert=(condition:unknown,message:string)=>{if(!condition) throw new Error(message);};
try {
  const clients=[];
  for(let index=0;index<3;index++) {
    const email=`rls-${index}-${suffix}@example.test`;
    const created=await admin.auth.admin.createUser({email,password,email_confirm:true});
    if(created.error || !created.data.user) throw created.error || new Error("Fixture user creation failed.");
    users.push(created.data.user.id);
    const client=createClient(url,anon,{auth:{persistSession:false,autoRefreshToken:false}});
    const signed=await client.auth.signInWithPassword({email,password}); if(signed.error) throw signed.error;
    clients.push(client);
  }
  for(let index=0;index<2;index++) {
    const org=await admin.from("organizations").insert({name:`Staging RLS ${suffix}-${index}`,status:"active"}).select("id").single();
    if(org.error || !org.data) throw org.error || new Error("Fixture organization creation failed.");
    orgs.push(org.data.id);
    const member=await admin.from("organization_members").insert({organization_id:org.data.id,user_id:users[index],role:"owner",status:"active"}); if(member.error) throw member.error;
  }
  const viewer=await admin.from("organization_members").insert({organization_id:orgs[0],user_id:users[2],role:"viewer",status:"active"}); if(viewer.error) throw viewer.error;
  const categories={income:[{id:"sales",label:"Sales",reportClass:"sales"}],expense:[{id:"goods",label:"Goods",cogs:true}]};
  const own=await clients[0].rpc("save_ledger_data",{p_org:orgs[0],p_expected:{categories:0},p_changes:{categories}}); if(own.error) throw own.error;
  const tx={id:"fixture-sale",date:"2026-10-18",category:"sales",type:"income",amount:100};
  const saved=await clients[0].rpc("save_ledger_data",{p_org:orgs[0],p_expected:{transactions:0},p_changes:{transactions:[tx]}}); if(saved.error) throw saved.error;
  const cross=await clients[1].rpc("read_ledger_data",{p_org:orgs[0]}); assert(cross.error,"Cross-tenant RPC must be denied");
  const directRead=await clients[1].from("transactions").select("id").eq("organization_id",orgs[0]); assert(!directRead.error && directRead.data.length===0,"Cross-tenant REST read must be empty");
  const directWrite=await clients[0].from("transactions").update({amount:1}).eq("organization_id",orgs[0]); assert(directWrite.error,"Direct writes must not bypass transactional operations");
  const readonly=await clients[2].rpc("save_ledger_data",{p_org:orgs[0],p_expected:{transactions:1},p_changes:{transactions:[]}}); assert(readonly.error,"Viewer write must be denied");
  const stale=await clients[0].rpc("save_ledger_data",{p_org:orgs[0],p_expected:{transactions:0},p_changes:{transactions:[]}}); assert(stale.error,"Stale writes must be denied");
  const suspended=await admin.from("organizations").update({status:"suspended"}).eq("id",orgs[0]); if(suspended.error) throw suspended.error;
  const blocked=await clients[0].rpc("read_ledger_data",{p_org:orgs[0]}); assert(blocked.error,"Suspended company access must be denied");
  console.log("Staging passed: owner persistence, direct-write protection, cross-tenant REST/RPC isolation, viewer restrictions, conflicts, and suspension.");
} finally {
  const cleanupErrors:string[]=[];
  for(const org of orgs) {
    const deleted=await admin.from("organizations").delete().eq("id",org); if(deleted.error) cleanupErrors.push(deleted.error.message);
  }
  for(const user of users) {const deleted=await admin.auth.admin.deleteUser(user);if(deleted.error) cleanupErrors.push(deleted.error.message);}
  if(cleanupErrors.length) {console.error("Staging fixture cleanup needs operator attention.",cleanupErrors);process.exitCode=1;}
}
