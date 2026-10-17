-- Tenant-owned relational tables backing every data collection persisted by
-- the existing ledger UI. Payload preserves UI record shape; typed columns,
-- constraints and foreign keys enforce core data invariants.

create table public.business_profiles (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz not null default now()
);
create table public.org_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz not null default now()
);
create table public.org_data_versions (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  data_key text not null check (data_key in ('transactions','credit_sales','budgets','gov_settings','business_profile','categories','stock_items','stock_movements','roles','workers','dispatches')),
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, data_key)
);
create table public.categories (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 120),
  category_type text not null check (category_type in ('income', 'expense')),
  label text not null check (char_length(label) between 1 and 160),
  cogs boolean not null default false,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (organization_id, id),
  check (category_type = 'expense' or cogs = false)
);
create table public.transactions (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 160),
  date date not null,
  transaction_type text not null check (transaction_type in ('income', 'expense')),
  category_id text not null,
  amount numeric(14,2) not null check (amount > 0),
  invoice_number text,
  invoice_issued_at timestamptz,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, invoice_number),
  foreign key (organization_id, category_id) references public.categories(organization_id, id) on update cascade on delete restrict
);
create index transactions_org_date_idx on public.transactions(organization_id, date desc);

create table public.credit_sales (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 160),
  category_id text not null,
  sale_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  status text not null default 'outstanding' check (status in ('outstanding', 'paid')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (organization_id, id),
  foreign key (organization_id, category_id) references public.categories(organization_id, id) on update cascade on delete restrict
);
create index credit_sales_org_status_idx on public.credit_sales(organization_id, status, sale_date desc);
create table public.credit_payments (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null,
  credit_sale_id text not null,
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  payment_method text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  primary key (organization_id, id),
  foreign key (organization_id, credit_sale_id) references public.credit_sales(organization_id, id) on delete cascade
);
create index credit_payments_org_date_idx on public.credit_payments(organization_id, payment_date desc);

create table public.budgets (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null,
  title text not null check (char_length(title) between 1 and 200),
  created_at timestamptz not null default now(),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (organization_id, id)
);
create table public.budget_items (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null,
  budget_id text not null,
  category_id text not null,
  amount_requested numeric(14,2) not null check (amount_requested > 0),
  status text not null check (status in ('pending', 'approved', 'rejected')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (organization_id, id),
  foreign key (organization_id, budget_id) references public.budgets(organization_id, id) on delete cascade,
  foreign key (organization_id, category_id) references public.categories(organization_id, id) on update cascade on delete restrict
);

create table public.stock_items (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null,
  name text not null check (char_length(name) between 1 and 160),
  unit text not null default 'units',
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (organization_id, id)
);
create table public.stock_movements (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null,
  item_id text not null,
  movement_date date not null,
  movement_type text not null check (movement_type in ('in', 'out')),
  quantity numeric(14,3) not null check (quantity > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (organization_id, id),
  foreign key (organization_id, item_id) references public.stock_items(organization_id, id) on delete cascade
);
create index stock_movements_org_item_date_idx on public.stock_movements(organization_id, item_id, movement_date);

create table public.commission_roles (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null,
  name text not null check (char_length(name) between 1 and 120),
  commission_type text not null check (commission_type in ('flat', 'percent')),
  rate numeric(14,2) not null default 0 check (rate >= 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (organization_id, id)
);
create table public.workers (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null,
  role_id text not null,
  name text not null check (char_length(name) between 1 and 160),
  phone text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (organization_id, id),
  foreign key (organization_id, role_id) references public.commission_roles(organization_id, id) on update cascade on delete restrict
);
create table public.dispatches (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null,
  dispatch_date date not null,
  status text not null check (status in ('yet_to_deliver', 'on_transit', 'delivered', 'returned')),
  product_amount numeric(14,2) not null default 0 check (product_amount >= 0),
  delivery_amount numeric(14,2) not null check (delivery_amount >= 0),
  dispatcher_id text,
  bdo_id text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (organization_id, id),
  foreign key (organization_id, dispatcher_id) references public.workers(organization_id, id) on delete restrict,
  foreign key (organization_id, bdo_id) references public.workers(organization_id, id) on delete restrict
);
create index dispatches_org_date_idx on public.dispatches(organization_id, dispatch_date desc);
create table public.vendor_remittances (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null,
  dispatch_id text not null,
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  payment_method text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  primary key (organization_id, id),
  unique (organization_id, dispatch_id),
  foreign key (organization_id, dispatch_id) references public.dispatches(organization_id, id) on delete cascade
);
create table public.commission_payments (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null,
  worker_id text not null,
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  payment_method text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  primary key (organization_id, id),
  foreign key (organization_id, worker_id) references public.workers(organization_id, id) on delete restrict
);

alter table public.audit_events add column app_record_id text;
alter table public.audit_events add column payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object');
create unique index audit_events_org_record_uidx on public.audit_events(organization_id, app_record_id) where app_record_id is not null;

do $$
declare t text;
begin
  foreach t in array array[
    'business_profiles','org_settings','categories','transactions','credit_sales','credit_payments','budgets','budget_items',
    'org_data_versions','stock_items','stock_movements','commission_roles','workers','dispatches','vendor_remittances','commission_payments'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy tenant_select on public.%I for select to authenticated using (public.can_access_organization(organization_id))', t);
    execute format('create policy tenant_insert on public.%I for insert to authenticated with check (public.can_access_organization(organization_id))', t);
    execute format('create policy tenant_update on public.%I for update to authenticated using (public.can_access_organization(organization_id)) with check (public.can_access_organization(organization_id))', t);
    execute format('create policy tenant_delete on public.%I for delete to authenticated using (public.can_access_organization(organization_id))', t);
  end loop;
end;
$$;

create policy audit_member_insert on public.audit_events for insert to authenticated
  with check (organization_id is not null and public.can_access_organization(organization_id) and actor_user_id = (select auth.uid()));

create function public.claim_org_data_version(p_organization_id uuid, p_data_key text, p_expected_version bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare next_version bigint;
begin
  if not public.can_access_organization(p_organization_id) then raise exception 'Forbidden'; end if;
  if p_data_key not in ('transactions','credit_sales','budgets','gov_settings','business_profile','categories','stock_items','stock_movements','roles','workers','dispatches') then
    raise exception 'Invalid data key';
  end if;
  if p_expected_version = 0 then
    insert into public.org_data_versions(organization_id, data_key, version)
      values (p_organization_id, p_data_key, 1) on conflict do nothing returning version into next_version;
  else
    update public.org_data_versions set version = version + 1, updated_at = now()
      where organization_id = p_organization_id and data_key = p_data_key and version = p_expected_version
      returning version into next_version;
  end if;
  return next_version;
end;
$$;
revoke all on function public.claim_org_data_version(uuid, text, bigint) from public, anon;
grant execute on function public.claim_org_data_version(uuid, text, bigint) to authenticated;

grant select on public.organizations, public.organization_members, public.platform_admins, public.organization_signup_requests, public.audit_events to authenticated;
grant usage on schema public to service_role;
grant all on public.organizations, public.organization_members, public.platform_admins, public.organization_signup_requests, public.audit_events to service_role;
grant usage, select on sequence public.audit_events_id_seq to service_role;
grant insert on public.audit_events to authenticated;
grant select on public.org_data_versions to authenticated;
grant select, insert, update, delete on public.business_profiles, public.org_settings, public.categories, public.transactions,
  public.credit_sales, public.credit_payments, public.budgets, public.budget_items, public.stock_items, public.stock_movements,
  public.commission_roles, public.workers, public.dispatches, public.vendor_remittances, public.commission_payments to authenticated;
grant all on public.business_profiles, public.org_settings, public.categories, public.transactions, public.credit_sales,
  public.credit_payments, public.budgets, public.budget_items, public.stock_items, public.stock_movements, public.commission_roles,
  public.workers, public.dispatches, public.vendor_remittances, public.commission_payments to service_role;
grant all on public.audit_events to service_role;
grant usage, select on sequence public.audit_events_id_seq to authenticated;
