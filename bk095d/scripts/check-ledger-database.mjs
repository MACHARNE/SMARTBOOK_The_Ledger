import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Real embedded PostgreSQL, entirely local. No .env, hosted users, or emails.
const db = new PGlite();
const ids = { owner: "10000000-0000-4000-8000-000000000001", accountant: "10000000-0000-4000-8000-000000000002", staff: "10000000-0000-4000-8000-000000000003", viewer: "10000000-0000-4000-8000-000000000004", other: "10000000-0000-4000-8000-000000000005", admin: "10000000-0000-4000-8000-000000000006" };
const org = "20000000-0000-4000-8000-000000000001";
const otherOrg = "20000000-0000-4000-8000-000000000002";
async function actor(name, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)", [ids[name], role]);
  await db.exec(`set role ${role}`);
}
async function read() { return (await db.query("select public.read_ledger_data($1) as result", [org])).rows[0].result; }
async function save(changes, expected) {
  const state = await read();
  expected ??= Object.fromEntries(Object.keys(changes).map(key => [key, state.versions[key] || 0]));
  return (await db.query("select public.save_ledger_data($1,$2,$3) as result", [org, expected, changes])).rows[0].result;
}
async function action(name, input, request = crypto.randomUUID(), expected) {
  expected ??= (await read()).versions;
  return (await db.query("select public.perform_ledger_action($1,$2,$3,$4,$5) as result", [org, name, input, expected, request])).rows[0].result;
}
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; grant usage on schema auth to authenticated,service_role;
    create table auth.users(id uuid primary key,email text,encrypted_password text,confirmation_token text,recovery_token text,email_change_token_new text,email_change text);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;`);
  const migrations = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => file.endsWith(".sql")).sort()) {
    // gen_random_uuid() is built into Postgres; hosted-only extension installation is unnecessary in this harness.
    const sql = (await readFile(new URL(file, migrations), "utf8")).replace(/create extension if not exists pgcrypto;/i, "");
    try { await db.exec(sql); } catch (error) { throw new Error(`${file}: ${error.message}`, { cause: error }); }
  }
  console.log("Clean database: all migrations applied.");
  await db.query("select set_config('request.jwt.claim.role','service_role',false)");
  for (const [name,id] of Object.entries(ids)) await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${name}@example.test`]);
  await db.query("insert into public.organizations(id,name,status) values($1,'Local A','active'),($2,'Local B','active')", [org,otherOrg]);
  for (const name of ["owner","accountant","staff","viewer"]) await db.query("insert into public.organization_members(organization_id,user_id,role,status) values($1,$2,$3,'active')", [org,ids[name],name]);
  await db.query("insert into public.organization_members(organization_id,user_id,role,status) values($1,$2,'owner','active')", [otherOrg,ids.other]);
  await db.query("insert into public.platform_admins(user_id,role) values($1,'admin')", [ids.admin]);
  await actor("owner");
  await save({categories:{income:[{id:"sales",label:"Sales",reportClass:"sales"},{id:"delivery",label:"Delivery",reportClass:"other_income"}],expense:[{id:"goods",label:"Goods",cogs:true},{id:"wages",label:"Wages",cogs:false}]}});
  await save({credit_sales:[{id:"credit-1",category:"sales",date:"2026-10-18",amount:500,status:"outstanding",customerName:"Fixture"}]});
  const request = crypto.randomUUID();
  const paid = await action("settle_credit",{id:"credit-1",date:"2026-10-18",method:"Cash"},request);
  assert.equal(paid.data.credit_sales[0].status,"paid");
  assert.equal(paid.data.transactions.length,1);
  assert.equal(paid.data.transactions[0].amount,500);
  const repeated = await action("settle_credit",{id:"credit-1"},request,{});
  assert.equal(repeated.data.transactions.length,1,"Same operation must not double count");
  await assert.rejects(action("settle_credit",{id:"credit-1"}),/already settled/);
  await assert.rejects(save({transactions:[]}),/cannot be deleted/);
  const before = await read();
  await assert.rejects(action("procure",{amount:100,category:"goods",date:"2026-10-18",stockItemId:"missing",quantity:2}),/foreign key/);
  const after = await read();
  assert.deepEqual(after,before,"A failed stock/expense operation must roll back data, versions, and audits");
  const tx={id:"ordinary",date:"2026-10-18",type:"income",category:"sales",amount:20};
  await save({transactions:[...after.data.transactions,tx]});
  await assert.rejects(save({transactions:after.data.transactions},{transactions:after.versions.transactions}),/another session/);
  const budget={id:"budget",title:"Local budget",createdAt:new Date().toISOString(),items:[{id:"line",category:"goods",amountRequested:100,status:"pending",retirements:[],description:"Goods"}]};
  await save({budgets:[budget]});
  await actor("accountant");
  await assert.rejects(action("decide_budget",{id:"line",budgetId:"budget",decision:"approved"}),/Only the organization owner/);
  await assert.rejects(save({budgets:[{...budget,items:[{...budget.items[0],status:"approved"}]}]}),/budget decision/);
  await actor("owner");
  await action("decide_budget",{id:"line",budgetId:"budget",decision:"approved"});
  await assert.rejects(action("retire_budget",{id:"line",budgetId:"budget",amount:110}),/overspend reason/);
  const retired = await action("retire_budget",{id:"line",budgetId:"budget",amount:60,method:"Cash"});
  assert.equal(retired.data.budgets[0].items[0].retirements[0].amount,60);
  await save({roles:[{id:"rider",name:"Rider",commissionType:"percent",rate:10}]});
  await save({workers:[{id:"worker",name:"Worker",roleId:"rider"}]});
  await save({dispatches:[{id:"dispatch",date:"2026-10-18",status:"yet_to_deliver",productAmount:1000,deliveryAmount:100,chargeIncluded:false,dispatcherId:"worker",bdoId:"",dispatcherCommissionPaid:false,bdoCommissionPaid:false,vendorRemitStatus:null}]});
  const delivered = await action("complete_dispatch",{id:"dispatch"});
  assert.equal(delivered.data.dispatches[0].vendorOwed,1000);
  assert.equal(delivered.data.dispatches[0].dispatcherCommission,10);
  await action("remit_vendor",{id:"dispatch",method:"Cash"});
  const commission = await action("pay_commission",{id:"worker",method:"Cash"});
  assert.equal(commission.data.dispatches[0].dispatcherCommissionPaid,true);
  await assert.rejects(action("pay_commission",{id:"worker"}),/No unpaid commission/);
  const full = await read();
  const bulk = Array.from({length:1100},(_,index)=>({id:`bulk-${index}`,date:"2026-10-18",type:"income",category:"sales",amount:1}));
  const complete = await save({transactions:[...full.data.transactions,...bulk]});
  assert.equal(complete.data.transactions.length,full.data.transactions.length+1100,"Complete snapshots must exceed the REST 1,000-row cap");
  await assert.rejects(save({transactions:complete.data.transactions},{transactions:null}),/another session/);
  await actor("staff");
  const staffState=await read();
  await save({transactions:[...staffState.data.transactions,{id:"staff-sale",date:"2026-10-18",type:"income",category:"sales",amount:10}]});
  await assert.rejects(action("settle_credit",{id:"credit-1"}),/Owner or accountant/);
  await assert.rejects(db.query("insert into public.audit_events(action,entity_type) values('forged','fixture')"),/permission denied/);
  await assert.rejects(db.query("update public.transactions set amount=1 where organization_id=$1",[org]),/permission denied/);
  await actor("viewer");
  await read();
  await assert.rejects(save({transactions:[]}),/Forbidden/);
  await actor("other");
  await assert.rejects(read(),/Forbidden/);
  await actor("admin");
  assert.equal((await db.query("select public.is_super_admin($1) as allowed",[ids.admin])).rows[0].allowed,false);
  console.log("Passed: atomic rollback, linked records, idempotency, conflict detection, budgets, dispatches, commissions, staff/viewer restrictions, trusted audits, and tenant isolation.");
} catch (error) { console.error(error.message); if (error.where) console.error(error.where); process.exitCode=1; }
finally { await db.close(); }
