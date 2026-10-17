create extension if not exists pgcrypto;

create type public.organization_status as enum ('pending', 'active', 'rejected', 'suspended');
create type public.member_status as enum ('invited', 'active', 'revoked');
create type public.organization_role as enum ('owner', 'accountant', 'staff', 'viewer');
create type public.signup_status as enum ('pending', 'active', 'rejected');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 160),
  status public.organization_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.organization_role not null default 'staff',
  status public.member_status not null default 'invited',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.organization_signup_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  requester_user_id uuid not null references auth.users(id) on delete cascade,
  company_name text not null,
  contact_name text not null,
  email text not null,
  phone text,
  status public.signup_status not null default 'pending',
  reviewed_by uuid references public.platform_admins(user_id),
  decision_reason text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index organization_members_user_idx on public.organization_members(user_id, status);
create index signup_requests_status_created_idx on public.organization_signup_requests(status, created_at);
create index audit_events_org_created_idx on public.audit_events(organization_id, created_at desc);

create function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.platform_admins a where a.user_id = (select auth.uid()))
$$;

create function public.can_access_organization(target_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organizations o
    join public.organization_members m on m.organization_id = o.id
    where o.id = target_org and o.status = 'active'
      and m.user_id = (select auth.uid()) and m.status = 'active'
  )
$$;

revoke all on function public.is_platform_admin() from public;
grant execute on function public.is_platform_admin() to authenticated;
revoke all on function public.can_access_organization(uuid) from public;
grant execute on function public.can_access_organization(uuid) to authenticated;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.platform_admins enable row level security;
alter table public.organization_signup_requests enable row level security;
alter table public.audit_events enable row level security;

create policy organizations_member_read on public.organizations for select to authenticated
  using (public.can_access_organization(id) or public.is_platform_admin());
create policy members_read_self_or_admin on public.organization_members for select to authenticated
  using (user_id = (select auth.uid()) or public.is_platform_admin());
create policy platform_admin_self_read on public.platform_admins for select to authenticated
  using (user_id = (select auth.uid()));
create policy signup_request_admin_read on public.organization_signup_requests for select to authenticated
  using (public.is_platform_admin());
create policy audit_org_read on public.audit_events for select to authenticated
  using ((organization_id is not null and public.can_access_organization(organization_id)) or public.is_platform_admin());

create function public.submit_organization_signup(
  p_user_id uuid, p_company_name text, p_contact_name text, p_email text, p_phone text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  new_org_id uuid;
begin
  if p_user_id is null or p_company_name is null or p_contact_name is null or p_email is null then
    raise exception 'Required signup fields are missing';
  end if;
  insert into public.organizations(name, status) values (p_company_name, 'pending') returning id into new_org_id;
  insert into public.organization_members(organization_id, user_id, role, status)
    values (new_org_id, p_user_id, 'owner', 'invited');
  insert into public.organization_signup_requests(organization_id, requester_user_id, company_name, contact_name, email, phone)
    values (new_org_id, p_user_id, p_company_name, p_contact_name, p_email, p_phone);
  insert into public.audit_events(organization_id, actor_user_id, action, entity_type, entity_id)
    values (new_org_id, p_user_id, 'signup_submitted', 'organization_signup_request', new_org_id::text);
  return new_org_id;
end;
$$;
revoke all on function public.submit_organization_signup(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.submit_organization_signup(uuid, text, text, text, text) to service_role;

create function public.decide_organization_request(
  p_actor_id uuid, p_request_id uuid, p_decision text, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  req public.organization_signup_requests%rowtype;
  next_status public.organization_status;
begin
  if not exists(select 1 from public.platform_admins a where a.user_id = p_actor_id) then
    raise exception 'Forbidden';
  end if;
  if p_decision not in ('activate', 'reject', 'suspend', 'reactivate') then raise exception 'Invalid decision'; end if;
  if p_decision in ('reject', 'suspend') and nullif(trim(p_reason), '') is null then raise exception 'A reason is required'; end if;
  select * into req from public.organization_signup_requests where id = p_request_id for update;
  if not found then raise exception 'Signup request not found'; end if;
  if p_decision in ('activate', 'reject') and req.status <> 'pending' then raise exception 'Request is no longer pending'; end if;
  if p_decision = 'suspend' and (select o.status from public.organizations o where o.id = req.organization_id) <> 'active' then raise exception 'Only active companies can be suspended'; end if;
  if p_decision = 'reactivate' and (select o.status from public.organizations o where o.id = req.organization_id) <> 'suspended' then raise exception 'Only suspended companies can be reactivated'; end if;

  if p_decision = 'activate' then
    next_status := 'active';
    update public.organization_signup_requests set status = 'active', reviewed_by = p_actor_id, reviewed_at = now(), decision_reason = null where id = req.id;
    update public.organization_members set status = 'active' where organization_id = req.organization_id and user_id = req.requester_user_id;
    insert into public.categories(organization_id, id, category_type, label, cogs, payload) values
      (req.organization_id, 'booking_sales', 'income', 'Booking Sales', false, '{"id":"booking_sales","label":"Booking Sales"}'::jsonb),
      (req.organization_id, 'direct_sales', 'income', 'Direct Sales', false, '{"id":"direct_sales","label":"Direct Sales"}'::jsonb),
      (req.organization_id, 'coop_fees', 'income', 'Cooperative / Franchise Fees', false, '{"id":"coop_fees","label":"Cooperative / Franchise Fees"}'::jsonb),
      (req.organization_id, 'other_income', 'income', 'Other Income', false, '{"id":"other_income","label":"Other Income"}'::jsonb),
      (req.organization_id, 'meat_purchase', 'expense', 'Goods / Materials Purchase', true, '{"id":"meat_purchase","label":"Goods / Materials Purchase","cogs":true}'::jsonb),
      (req.organization_id, 'processing', 'expense', 'Processing & Packaging', true, '{"id":"processing","label":"Processing & Packaging","cogs":true}'::jsonb),
      (req.organization_id, 'logistics', 'expense', 'Logistics & Transport', false, '{"id":"logistics","label":"Logistics & Transport","cogs":false}'::jsonb),
      (req.organization_id, 'salaries', 'expense', 'Salaries & Wages', false, '{"id":"salaries","label":"Salaries & Wages","cogs":false}'::jsonb),
      (req.organization_id, 'rent_utilities', 'expense', 'Rent & Utilities', false, '{"id":"rent_utilities","label":"Rent & Utilities","cogs":false}'::jsonb),
      (req.organization_id, 'marketing', 'expense', 'Marketing & Outreach', false, '{"id":"marketing","label":"Marketing & Outreach","cogs":false}'::jsonb),
      (req.organization_id, 'admin', 'expense', 'Admin & Miscellaneous', false, '{"id":"admin","label":"Admin & Miscellaneous","cogs":false}'::jsonb)
    on conflict (organization_id, id) do nothing;
    insert into public.commission_roles(organization_id, id, name, commission_type, rate, payload) values
      (req.organization_id, 'dispatcher', 'Dispatcher', 'flat', 0, '{"id":"dispatcher","name":"Dispatcher","commissionType":"flat","rate":0}'::jsonb),
      (req.organization_id, 'bdo', 'BDO', 'flat', 0, '{"id":"bdo","name":"BDO","commissionType":"flat","rate":0}'::jsonb)
    on conflict (organization_id, id) do nothing;
  elsif p_decision = 'reject' then
    next_status := 'rejected';
    update public.organization_signup_requests set status = 'rejected', reviewed_by = p_actor_id, reviewed_at = now(), decision_reason = trim(p_reason) where id = req.id;
    update public.organization_members set status = 'revoked' where organization_id = req.organization_id;
  elsif p_decision = 'suspend' then
    next_status := 'suspended';
  else
    next_status := 'active';
  end if;

  update public.organizations set status = next_status, updated_at = now() where id = req.organization_id;
  insert into public.audit_events(organization_id, actor_user_id, action, entity_type, entity_id, details)
    values (req.organization_id, p_actor_id, p_decision, 'organization', req.organization_id::text, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('organization_id', req.organization_id, 'status', next_status);
end;
$$;
revoke all on function public.decide_organization_request(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.decide_organization_request(uuid, uuid, text, text) to service_role;

-- Initial platform admins must be inserted by a trusted project operator after the Auth user exists.
-- Example (run manually in the Supabase SQL editor):
-- insert into public.platform_admins(user_id) values ('<auth.users UUID>');
