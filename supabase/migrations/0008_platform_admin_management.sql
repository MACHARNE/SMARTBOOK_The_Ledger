-- Both platform roles may manage companies and administrator access.
-- Existing server-only grants, audit transactions and last-super-admin protection remain.

create or replace function public.decide_organization_request(p_actor_id uuid,p_request_id uuid,p_decision text,p_reason text default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.is_platform_admin(p_actor_id) then raise exception 'Forbidden' using errcode='42501'; end if;
  return public.decide_organization_request_internal(p_actor_id,p_request_id,p_decision,p_reason);
end $$;

create or replace function public.provision_company_owner(p_actor_id uuid,p_user_id uuid,p_company_name text,p_contact_name text,p_email text,p_phone text default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare org_id uuid;
begin
  if not public.is_platform_admin(p_actor_id) then raise exception 'Forbidden' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(lower(p_email)||':'||lower(p_company_name),0));
  select organization_id into org_id from public.organization_signup_requests where lower(email)=lower(p_email) and lower(company_name)=lower(p_company_name) and requester_user_id=p_user_id;
  if org_id is not null then return org_id; end if;
  insert into public.organizations(name,status) values(p_company_name,'pending') returning id into org_id;
  insert into public.organization_members(organization_id,user_id,role,status,invited_by) values(org_id,p_user_id,'owner','invited',p_actor_id);
  insert into public.organization_signup_requests(organization_id,requester_user_id,company_name,contact_name,email,phone) values(org_id,p_user_id,p_company_name,p_contact_name,p_email,p_phone);
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,details) values(org_id,p_actor_id,'company_owner_invited','organization',org_id::text,jsonb_build_object('email',p_email));
  return org_id;
end $$;

create or replace function public.provision_platform_admin(p_actor_id uuid,p_user_id uuid,p_role text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('platform-admin-provisioning',0));
  if not public.is_platform_admin(p_actor_id) or p_role is null or p_role not in ('admin','super_admin') then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_actor_id=p_user_id and exists(select 1 from public.platform_admins where user_id=p_user_id and role<>p_role) then raise exception 'Ask another administrator to change your own access'; end if;
  if p_role='admin' and exists(select 1 from public.platform_admins where user_id=p_user_id and role='super_admin') and not exists(select 1 from public.platform_admins where user_id<>p_user_id and role='super_admin') then raise exception 'The last super admin cannot be demoted'; end if;
  insert into public.platform_admins(user_id,role,created_by) values(p_user_id,p_role,p_actor_id) on conflict(user_id) do update set role=excluded.role;
  insert into public.audit_events(actor_user_id,action,entity_type,entity_id,details) values(p_actor_id,'platform_admin_invited','platform_admin',p_user_id::text,jsonb_build_object('role',p_role));
end $$;

create or replace function public.export_ledger_data(p_actor_id uuid,p_org uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t text; rows jsonb; result jsonb:='{}';
begin
  if not public.is_platform_admin(p_actor_id) then raise exception 'Forbidden' using errcode='42501'; end if;
  for t in select unnest(array['business_profiles','categories','transactions','credit_sales','credit_payments','budgets','budget_items','budget_retirements','audit_events','stock_items','stock_movements','commission_roles','workers','dispatches','vendor_remittances','commission_payments']) loop
    execute format('select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)->>''id''),''[]''::jsonb) from public.%I r where organization_id=$1',t) into rows using p_org;
    result:=result||jsonb_build_object(t,rows);
  end loop;
  return result;
end $$;

create or replace function public.list_platform_administrators(p_actor_id uuid,p_page integer default 0,p_search text default '',p_role text default 'all') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare records jsonb; total bigint; query text:=lower(trim(coalesce(p_search,'')));
begin
  if not public.is_platform_admin(p_actor_id) then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_page is null or p_page<0 or p_page>10000 or char_length(query)>100 or p_role is null or p_role not in ('all','admin','super_admin') then raise exception 'Invalid administrator filters'; end if;
  select count(*) into total from public.platform_admins a join auth.users u on u.id=a.user_id
    where (p_role='all' or a.role=p_role) and (query='' or position(query in lower(coalesce(u.email,'')))>0);
  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc,r.user_id),'[]') into records from (
    select a.user_id,a.role,a.created_at,u.email,
      case when coalesce(u.raw_app_meta_data->>'force_password_reset','false')='true' or u.email_confirmed_at is null then 'setup_pending' else 'active' end as status,u.last_sign_in_at
    from public.platform_admins a join auth.users u on u.id=a.user_id
    where (p_role='all' or a.role=p_role) and (query='' or position(query in lower(coalesce(u.email,'')))>0)
    order by a.created_at desc,a.user_id limit 20 offset p_page*20
  ) r;
  return jsonb_build_object('administrators',records,'total',total,'page',p_page,'pageSize',20);
end $$;

create or replace function public.manage_platform_administrator(p_actor_id uuid,p_user_id uuid,p_action text,p_role text default null,p_reason text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare previous_role text;
begin
  perform pg_advisory_xact_lock(hashtextextended('platform-admin-provisioning',0));
  if not public.is_platform_admin(p_actor_id) then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_action is null or p_action not in ('change-role','revoke') then raise exception 'Unsupported administrator action'; end if;
  if p_user_id=p_actor_id then raise exception 'Ask another administrator to change your own access'; end if;
  select role into previous_role from public.platform_admins where user_id=p_user_id for update;
  if previous_role is null then raise exception 'Administrator not found'; end if;
  if p_action='change-role' and (p_role is null or p_role not in ('admin','super_admin')) then raise exception 'Select a valid administrator role'; end if;
  if char_length(coalesce(p_reason,''))>1000 then raise exception 'Reason must be 1000 characters or fewer'; end if;
  if p_action='revoke' and nullif(trim(p_reason),'') is null then raise exception 'A reason is required to remove platform access'; end if;
  if previous_role='super_admin' and (p_action='revoke' or p_role='admin') and not exists(select 1 from public.platform_admins where user_id<>p_user_id and role='super_admin') then raise exception 'The last super admin cannot be removed or demoted'; end if;
  if p_action='change-role' then
    if p_role=previous_role then return jsonb_build_object('changed',false); end if;
    update public.platform_admins set role=p_role where user_id=p_user_id;
  else delete from public.platform_admins where user_id=p_user_id;
  end if;
  insert into public.audit_events(actor_user_id,action,entity_type,entity_id,details)
    values(p_actor_id,case when p_action='revoke' then 'platform_admin_revoked' else 'platform_admin_role_changed' end,'platform_admin',p_user_id::text,
      jsonb_build_object('previousRole',previous_role,'role',case when p_action='revoke' then null else p_role end,'reason',nullif(trim(p_reason),'')));
  return jsonb_build_object('changed',true);
end $$;
