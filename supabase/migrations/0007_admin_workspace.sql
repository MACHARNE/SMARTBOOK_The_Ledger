-- Administrative queries are server-only; access changes are audited atomically.
alter table public.organization_signup_requests drop constraint if exists organization_signup_requests_reviewed_by_fkey;
alter table public.organization_signup_requests add constraint organization_signup_requests_reviewer_identity_fkey
  foreign key(reviewed_by) references auth.users(id) on delete set null;

create function public.admin_workspace_summary(p_actor_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not public.is_platform_admin(p_actor_id) then raise exception 'Forbidden' using errcode='42501'; end if;
  return (select jsonb_build_object('totalCompanies',count(*),'activeCompanies',count(*) filter(where status='active'),
    'pendingCompanies',count(*) filter(where status='pending'),'suspendedCompanies',count(*) filter(where status='suspended'),
    'expiringTrials',count(*) filter(where status='active' and trial_ends_at>=now() and trial_ends_at<now()+interval '7 days'),
    'expiredTrials',count(*) filter(where status='active' and trial_ends_at<now()),
    'pendingRequests',(select count(*) from public.organization_signup_requests where status='pending'),'asOf',now()) from public.organizations);
end $$;
revoke all on function public.admin_workspace_summary(uuid) from public,anon,authenticated;
grant execute on function public.admin_workspace_summary(uuid) to service_role;

create function public.list_platform_administrators(p_actor_id uuid,p_page integer default 0,p_search text default '',p_role text default 'all') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare records jsonb; total bigint; query text:=lower(trim(coalesce(p_search,'')));
begin
  if not public.is_super_admin(p_actor_id) then raise exception 'Forbidden' using errcode='42501'; end if;
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
revoke all on function public.list_platform_administrators(uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.list_platform_administrators(uuid,integer,text,text) to service_role;

create function public.manage_platform_administrator(p_actor_id uuid,p_user_id uuid,p_action text,p_role text default null,p_reason text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare previous_role text;
begin
  perform pg_advisory_xact_lock(hashtextextended('platform-admin-provisioning',0));
  if not public.is_super_admin(p_actor_id) then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_action is null or p_action not in ('change-role','revoke') then raise exception 'Unsupported administrator action'; end if;
  if p_user_id=p_actor_id then raise exception 'Ask another super admin to change your own access'; end if;
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
revoke all on function public.manage_platform_administrator(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.manage_platform_administrator(uuid,uuid,text,text,text) to service_role;

create index if not exists audit_events_platform_created_idx on public.audit_events(created_at desc,id desc)
  where action in ('activate','reject','suspend','reactivate','company_owner_invited','platform_admin_invited','platform_admin_role_changed','platform_admin_revoked','set_trial','membership_invited','membership_revoked','member_role_changed','organization_exported');
