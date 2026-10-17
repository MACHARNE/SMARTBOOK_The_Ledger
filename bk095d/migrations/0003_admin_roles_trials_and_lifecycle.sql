-- Add named admin roles, organization slugs/trials, and audited lifecycle helpers.
alter table public.platform_admins add column if not exists role text not null default 'admin'
  check (role in ('super_admin','admin'));
alter table public.platform_admins add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.organization_members add column if not exists invited_by uuid references auth.users(id) on delete set null;
alter table public.organization_members add column if not exists updated_at timestamptz not null default now();
alter table public.organization_signup_requests add column if not exists updated_at timestamptz not null default now();
alter table public.audit_events add column if not exists updated_at timestamptz not null default now();
alter table public.org_data_versions add column if not exists created_at timestamptz not null default now();
alter table public.business_profiles add column if not exists created_at timestamptz not null default now();
alter table public.org_settings add column if not exists created_at timestamptz not null default now();
alter table public.categories add column if not exists created_at timestamptz not null default now();
alter table public.categories add column if not exists updated_at timestamptz not null default now();
alter table public.transactions add column if not exists updated_at timestamptz not null default now();
alter table public.credit_sales add column if not exists created_at timestamptz not null default now();
alter table public.credit_sales add column if not exists updated_at timestamptz not null default now();
alter table public.credit_payments add column if not exists created_at timestamptz not null default now();
alter table public.credit_payments add column if not exists updated_at timestamptz not null default now();
alter table public.budgets add column if not exists updated_at timestamptz not null default now();
alter table public.budget_items add column if not exists created_at timestamptz not null default now();
alter table public.budget_items add column if not exists updated_at timestamptz not null default now();
alter table public.stock_items add column if not exists created_at timestamptz not null default now();
alter table public.stock_items add column if not exists updated_at timestamptz not null default now();
alter table public.stock_movements add column if not exists created_at timestamptz not null default now();
alter table public.stock_movements add column if not exists updated_at timestamptz not null default now();
alter table public.commission_roles add column if not exists created_at timestamptz not null default now();
alter table public.commission_roles add column if not exists updated_at timestamptz not null default now();
alter table public.workers add column if not exists created_at timestamptz not null default now();
alter table public.workers add column if not exists updated_at timestamptz not null default now();
alter table public.dispatches add column if not exists created_at timestamptz not null default now();
alter table public.dispatches add column if not exists updated_at timestamptz not null default now();
alter table public.vendor_remittances add column if not exists created_at timestamptz not null default now();
alter table public.vendor_remittances add column if not exists updated_at timestamptz not null default now();
alter table public.commission_payments add column if not exists created_at timestamptz not null default now();
alter table public.commission_payments add column if not exists updated_at timestamptz not null default now();
alter table public.organizations add column if not exists slug text;
alter table public.organizations add column if not exists rejection_reason text;
alter table public.organizations add column if not exists trial_unit text check (trial_unit in ('day','week','month','year'));
alter table public.organizations add column if not exists trial_count integer check (trial_count is null or trial_count > 0);
alter table public.organizations add column if not exists trial_started_at timestamptz;
alter table public.organizations add column if not exists trial_ends_at timestamptz;
update public.organizations set slug=coalesce(nullif(trim(both '-' from regexp_replace(lower(name),'[^a-z0-9]+','-','g')),''),'company')||'-'||left(id::text,8) where slug is null;
alter table public.organizations alter column slug set not null;
create unique index if not exists organizations_slug_uidx on public.organizations(slug);
alter table public.organizations alter column slug set default ('organization-' || left(gen_random_uuid()::text,8));
do $$ begin
  if not exists(select 1 from pg_constraint where conname='organizations_trial_fields_consistent' and conrelid='public.organizations'::regclass) then
    alter table public.organizations add constraint organizations_trial_fields_consistent check (
      (trial_unit is null and trial_count is null and trial_started_at is null and trial_ends_at is null)
      or (trial_unit is not null and trial_count is not null and trial_started_at is not null and trial_ends_at > trial_started_at)
    );
  end if;
end $$;

alter table public.platform_admins enable row level security;
revoke insert, update, delete on public.platform_admins from anon, authenticated;
revoke insert, update, delete on public.organizations from anon, authenticated;
revoke insert, update, delete on public.organization_members from anon, authenticated;
revoke insert, update, delete on public.organization_signup_requests from anon, authenticated;

create or replace function public.is_platform_admin(p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (p_uid = (select auth.uid()) or (select auth.role()) = 'service_role') and exists(select 1 from public.platform_admins a where a.user_id = p_uid)
$$;
revoke all on function public.is_platform_admin(uuid) from public;
grant execute on function public.is_platform_admin(uuid) to authenticated, service_role;

create or replace function public.is_active_member(p_uid uuid, p_org_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (p_uid = (select auth.uid()) or (select auth.role()) = 'service_role') and exists (
    select 1 from public.organizations o join public.organization_members m on m.organization_id=o.id
    where o.id=p_org_id and o.status='active' and m.user_id=p_uid and m.status='active'
  )
$$;
revoke all on function public.is_active_member(uuid,uuid) from public;
grant execute on function public.is_active_member(uuid,uuid) to authenticated, service_role;

-- Existing RLS predicates resolve through this function, which includes both active states.
create or replace function public.can_access_organization(target_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_platform_admin((select auth.uid())) or public.is_active_member((select auth.uid()), target_org)
$$;

create or replace function public.decide_organization_request(
  p_actor_id uuid, p_request_id uuid, p_decision text, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare req public.organization_signup_requests%rowtype; next_status public.organization_status;
begin
  if not public.is_platform_admin(p_actor_id) then raise exception 'Forbidden'; end if;
  if p_decision not in ('activate','reject','suspend','reactivate') then raise exception 'Invalid decision'; end if;
  if p_decision in ('reject','suspend') and nullif(trim(p_reason),'') is null then raise exception 'A reason is required'; end if;
  select * into req from public.organization_signup_requests where id=p_request_id for update;
  if not found then raise exception 'Signup request not found'; end if;
  if p_decision in ('activate','reject') and req.status <> 'pending' then raise exception 'Request is no longer pending'; end if;
  if p_decision='suspend' and (select status from public.organizations where id=req.organization_id) <> 'active' then raise exception 'Only active companies can be suspended'; end if;
  if p_decision='reactivate' and (select status from public.organizations where id=req.organization_id) <> 'suspended' then raise exception 'Only suspended companies can be reactivated'; end if;
  if p_decision='activate' then
    next_status := 'active';
    update public.organization_signup_requests set status='active', reviewed_by=p_actor_id, reviewed_at=now(), decision_reason=null where id=req.id;
    update public.organization_members set status='active' where organization_id=req.organization_id and user_id=req.requester_user_id;
    insert into public.categories(organization_id,id,category_type,label,cogs,payload) values
      (req.organization_id,'booking_sales','income','Booking Sales',false,'{"id":"booking_sales","label":"Booking Sales"}'::jsonb),
      (req.organization_id,'direct_sales','income','Direct Sales',false,'{"id":"direct_sales","label":"Direct Sales"}'::jsonb),
      (req.organization_id,'coop_fees','income','Cooperative / Franchise Fees',false,'{"id":"coop_fees","label":"Cooperative / Franchise Fees"}'::jsonb),
      (req.organization_id,'other_income','income','Other Income',false,'{"id":"other_income","label":"Other Income"}'::jsonb),
      (req.organization_id,'meat_purchase','expense','Goods / Materials Purchase',true,'{"id":"meat_purchase","label":"Goods / Materials Purchase","cogs":true}'::jsonb),
      (req.organization_id,'processing','expense','Processing & Packaging',true,'{"id":"processing","label":"Processing & Packaging","cogs":true}'::jsonb),
      (req.organization_id,'logistics','expense','Logistics & Transport',false,'{"id":"logistics","label":"Logistics & Transport","cogs":false}'::jsonb),
      (req.organization_id,'salaries','expense','Salaries & Wages',false,'{"id":"salaries","label":"Salaries & Wages","cogs":false}'::jsonb),
      (req.organization_id,'rent_utilities','expense','Rent & Utilities',false,'{"id":"rent_utilities","label":"Rent & Utilities","cogs":false}'::jsonb),
      (req.organization_id,'marketing','expense','Marketing & Outreach',false,'{"id":"marketing","label":"Marketing & Outreach","cogs":false}'::jsonb),
      (req.organization_id,'admin','expense','Admin & Miscellaneous',false,'{"id":"admin","label":"Admin & Miscellaneous","cogs":false}'::jsonb)
      on conflict(organization_id,id) do nothing;
    insert into public.commission_roles(organization_id,id,name,commission_type,rate,payload) values
      (req.organization_id,'dispatcher','Dispatcher','flat',0,'{"id":"dispatcher","name":"Dispatcher","commissionType":"flat","rate":0}'::jsonb),
      (req.organization_id,'bdo','BDO','flat',0,'{"id":"bdo","name":"BDO","commissionType":"flat","rate":0}'::jsonb)
      on conflict(organization_id,id) do nothing;
  elsif p_decision='reject' then
    next_status := 'rejected';
    update public.organization_signup_requests set status='rejected', reviewed_by=p_actor_id, reviewed_at=now(), decision_reason=trim(p_reason) where id=req.id;
    update public.organizations set rejection_reason=trim(p_reason) where id=req.organization_id;
    update public.organization_members set status='revoked' where organization_id=req.organization_id;
  elsif p_decision='suspend' then
    next_status := 'suspended';
  else
    next_status := 'active';
  end if;
  update public.organizations set status=next_status, updated_at=now() where id=req.organization_id;
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,details)
    values(req.organization_id,p_actor_id,p_decision,'organization',req.organization_id::text,jsonb_build_object('reason',p_reason));
  return jsonb_build_object('organization_id',req.organization_id,'status',next_status);
end $$;

create or replace function public.set_organization_trial(p_actor_id uuid,p_org_id uuid,p_unit text,p_count integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare started timestamptz := now(); ends timestamptz;
begin
  if not public.is_platform_admin(p_actor_id) then raise exception 'Forbidden'; end if;
  if p_unit not in ('day','week','month','year') or p_count is null or p_count < 1 or p_count > 1000 then raise exception 'Invalid trial'; end if;
  ends := case p_unit when 'day' then started + make_interval(days=>p_count) when 'week' then started + make_interval(days=>p_count*7)
    when 'month' then started + make_interval(months=>p_count) else started + make_interval(years=>p_count) end;
  update public.organizations set trial_unit=p_unit,trial_count=p_count,trial_started_at=started,trial_ends_at=ends,updated_at=now() where id=p_org_id;
  if not found then raise exception 'Organization not found'; end if;
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,details)
    values(p_org_id,p_actor_id,'set_trial','organization',p_org_id::text,jsonb_build_object('unit',p_unit,'count',p_count,'ends_at',ends));
  return jsonb_build_object('trial_unit',p_unit,'trial_count',p_count,'trial_started_at',started,'trial_ends_at',ends);
end $$;

create or replace function public.set_member_status(p_actor_id uuid,p_org_id uuid,p_user_id uuid,p_status text,p_role text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare old_row public.organization_members%rowtype;
begin
  if not public.is_platform_admin(p_actor_id) and not exists(select 1 from public.organization_members m join public.organizations o on o.id=m.organization_id
    where m.organization_id=p_org_id and m.user_id=p_actor_id and m.role='owner' and m.status='active' and o.status='active') then raise exception 'Forbidden'; end if;
  if p_status not in ('invited','active','revoked') or (p_role is not null and p_role not in ('owner','accountant','staff','viewer')) then raise exception 'Invalid membership'; end if;
  select * into old_row from public.organization_members where organization_id=p_org_id and user_id=p_user_id for update;
  if p_status='revoked' then update public.organization_members set status='revoked',updated_at=now() where organization_id=p_org_id and user_id=p_user_id;
  elsif found then update public.organization_members set status=p_status::public.member_status, role=coalesce(p_role,role),updated_at=now() where organization_id=p_org_id and user_id=p_user_id;
  else insert into public.organization_members(organization_id,user_id,role,status,invited_by) values(p_org_id,p_user_id,coalesce(p_role,'staff')::public.organization_role,p_status::public.member_status,p_actor_id); end if;
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,details)
    values(p_org_id,p_actor_id,case when p_status='active' and p_role is not null then 'member_role_changed' else 'membership_'||p_status end,'organization_member',p_user_id::text,jsonb_build_object('role',p_role));
  return jsonb_build_object('user_id',p_user_id,'status',p_status,'role',coalesce(p_role,old_row.role::text));
end $$;

create or replace function public.activate_organization(p_actor_id uuid,p_org_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request_id uuid;
begin select id into request_id from public.organization_signup_requests where organization_id=p_org_id;
  if request_id is null then raise exception 'Signup request not found'; end if;
  return public.decide_organization_request(p_actor_id,request_id,'activate',null);
end $$;
create or replace function public.reject_organization(p_actor_id uuid,p_org_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request_id uuid;
begin select id into request_id from public.organization_signup_requests where organization_id=p_org_id;
  if request_id is null then raise exception 'Signup request not found'; end if;
  return public.decide_organization_request(p_actor_id,request_id,'reject',p_reason);
end $$;
create or replace function public.suspend_organization(p_actor_id uuid,p_org_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request_id uuid;
begin select id into request_id from public.organization_signup_requests where organization_id=p_org_id;
  if request_id is null then raise exception 'Signup request not found'; end if;
  return public.decide_organization_request(p_actor_id,request_id,'suspend',p_reason);
end $$;
create or replace function public.reactivate_organization(p_actor_id uuid,p_org_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request_id uuid;
begin select id into request_id from public.organization_signup_requests where organization_id=p_org_id;
  if request_id is null then raise exception 'Signup request not found'; end if;
  return public.decide_organization_request(p_actor_id,request_id,'reactivate',null);
end $$;
create or replace function public.set_trial(p_actor_id uuid,p_org_id uuid,p_unit text,p_count integer) returns jsonb
language sql security definer set search_path = '' as $$ select public.set_organization_trial(p_actor_id,p_org_id,p_unit,p_count) $$;
create or replace function public.invite_member(p_actor_id uuid,p_org_id uuid,p_user_id uuid,p_role text) returns jsonb
language sql security definer set search_path = '' as $$ select public.set_member_status(p_actor_id,p_org_id,p_user_id,'invited',p_role) $$;
create or replace function public.revoke_member(p_actor_id uuid,p_org_id uuid,p_user_id uuid) returns jsonb
language sql security definer set search_path = '' as $$ select public.set_member_status(p_actor_id,p_org_id,p_user_id,'revoked',null) $$;
create or replace function public.change_member_role(p_actor_id uuid,p_org_id uuid,p_user_id uuid,p_role text) returns jsonb
language sql security definer set search_path = '' as $$ select public.set_member_status(p_actor_id,p_org_id,p_user_id,'active',p_role) $$;

create or replace function public.accept_member_invitation(p_user_id uuid,p_org_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare member_state public.member_status; org_state public.organization_status;
begin
  select m.status,o.status into member_state,org_state from public.organization_members m join public.organizations o on o.id=m.organization_id
    where m.user_id=p_user_id and m.organization_id=p_org_id for update of m;
  if not found then raise exception 'Invitation not found'; end if;
  if org_state <> 'active' then return false; end if;
  if member_state='active' then return true; end if;
  if member_state <> 'invited' then raise exception 'Invitation is no longer valid'; end if;
  update public.organization_members set status='active',updated_at=now() where organization_id=p_org_id and user_id=p_user_id;
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id)
    values(p_org_id,p_user_id,'membership_accepted','organization_member',p_user_id::text);
  return true;
end $$;

revoke all on function public.set_organization_trial(uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.set_organization_trial(uuid,uuid,text,integer) to service_role;
revoke all on function public.set_member_status(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.set_member_status(uuid,uuid,uuid,text,text) to service_role;
revoke all on function public.decide_organization_request(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.decide_organization_request(uuid,uuid,text,text) to service_role;
revoke all on function public.activate_organization(uuid,uuid),public.reactivate_organization(uuid,uuid) from public,anon,authenticated;
revoke all on function public.reject_organization(uuid,uuid,text),public.suspend_organization(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.set_trial(uuid,uuid,text,integer),public.invite_member(uuid,uuid,uuid,text),public.revoke_member(uuid,uuid,uuid),public.change_member_role(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.accept_member_invitation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.activate_organization(uuid,uuid),public.reactivate_organization(uuid,uuid) to service_role;
grant execute on function public.reject_organization(uuid,uuid,text),public.suspend_organization(uuid,uuid,text) to service_role;
grant execute on function public.set_trial(uuid,uuid,text,integer),public.invite_member(uuid,uuid,uuid,text),public.revoke_member(uuid,uuid,uuid),public.change_member_role(uuid,uuid,uuid,text) to service_role;
grant execute on function public.accept_member_invitation(uuid,uuid) to service_role;

-- Keep the audit stream append-only for authenticated callers.
create or replace function public.deny_audit_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Audit events are append-only'; end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
drop trigger if exists audit_events_no_mutation on public.audit_events;
create trigger audit_events_no_mutation before update or delete on public.audit_events for each row execute function public.deny_audit_mutation();

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$ begin new.updated_at=now(); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['organizations','organization_members','organization_signup_requests','business_profiles','org_settings','categories','transactions','credit_sales','credit_payments','budgets','budget_items','audit_events','org_data_versions','stock_items','stock_movements','commission_roles','workers','dispatches','vendor_remittances','commission_payments'] loop
    execute format('drop trigger if exists touch_updated_at on public.%I',t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function public.touch_updated_at()',t);
  end loop;
end $$;
