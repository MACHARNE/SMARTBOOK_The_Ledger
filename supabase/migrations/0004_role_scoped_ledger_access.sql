-- Restrict tenant data to active organization members and apply role-aware writes.
-- Platform administrators continue to manage organizations through protected APIs,
-- but do not receive implicit access to company books through the browser client.

create or replace function public.can_access_organization(target_org uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_active_member((select auth.uid()), target_org)
$$;
revoke all on function public.can_access_organization(uuid) from public;
grant execute on function public.can_access_organization(uuid) to authenticated, service_role;

create or replace function public.can_write_organization(target_org uuid, p_data_key text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = target_org
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and o.status = 'active'
      and (
        m.role in ('owner', 'accountant')
      )
  )
$$;
revoke all on function public.can_write_organization(uuid, text) from public;
grant execute on function public.can_write_organization(uuid, text) to authenticated, service_role;

create or replace function public.can_insert_organization_data(target_org uuid, p_data_key text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select public.can_write_organization(target_org, p_data_key)
    or exists (
      select 1
      from public.organization_members m
      join public.organizations o on o.id = m.organization_id
      where m.organization_id = target_org
        and m.user_id = (select auth.uid())
        and m.status = 'active'
        and o.status = 'active'
        and m.role = 'staff'
        and p_data_key in ('transactions', 'credit_sales', 'dispatches')
    )
$$;
revoke all on function public.can_insert_organization_data(uuid, text) from public;
grant execute on function public.can_insert_organization_data(uuid, text) to authenticated, service_role;

do $$
declare
  item record;
begin
  for item in
    select * from (values
      ('business_profiles', 'business_profile'),
      ('org_settings', 'gov_settings'),
      ('categories', 'categories'),
      ('transactions', 'transactions'),
      ('credit_sales', 'credit_sales'),
      ('credit_payments', 'credit_payments'),
      ('budgets', 'budgets'),
      ('budget_items', 'budgets'),
      ('stock_items', 'stock_items'),
      ('stock_movements', 'stock_movements'),
      ('commission_roles', 'roles'),
      ('workers', 'workers'),
      ('dispatches', 'dispatches'),
      ('vendor_remittances', 'vendor_remittances'),
      ('commission_payments', 'commission_payments')
    ) as policy_table(table_name, data_key)
  loop
    execute format('drop policy if exists tenant_insert on public.%I', item.table_name);
    execute format('drop policy if exists tenant_update on public.%I', item.table_name);
    execute format('drop policy if exists tenant_delete on public.%I', item.table_name);
    if item.table_name = 'transactions' then
      execute format(
        'create policy tenant_insert on public.%I for insert to authenticated with check (public.can_insert_organization_data(organization_id, %L) and (public.can_write_organization(organization_id, %L) or (transaction_type = %L and payload->>%L = %L and payload->>%L = category_id and (payload->>%L)::numeric = amount and payload->>%L = id and payload->>%L = date::text and not (payload ? %L))))',
        item.table_name, item.data_key, item.data_key, 'income', 'type', 'income', 'category', 'amount', 'id', 'date', 'creditId'
      );
    elsif item.table_name = 'credit_sales' then
      execute format(
        'create policy tenant_insert on public.%I for insert to authenticated with check (public.can_insert_organization_data(organization_id, %L) and (public.can_write_organization(organization_id, %L) or (status = %L and payload->>%L = %L and payload->>%L = category_id and (payload->>%L)::numeric = amount and payload->>%L = id and payload->>%L = sale_date::text)))',
        item.table_name, item.data_key, item.data_key, 'outstanding', 'status', 'outstanding', 'category', 'amount', 'id', 'date'
      );
    elsif item.table_name = 'dispatches' then
      execute format(
        'create policy tenant_insert on public.%I for insert to authenticated with check (public.can_insert_organization_data(organization_id, %L) and (public.can_write_organization(organization_id, %L) or (status = %L and payload->>%L = %L and payload->>%L = id and payload->>%L = dispatch_date::text and (payload->>%L)::numeric = product_amount and (payload->>%L)::numeric = delivery_amount)))',
        item.table_name, item.data_key, item.data_key, 'yet_to_deliver', 'status', 'yet_to_deliver', 'id', 'date', 'productAmount', 'deliveryAmount'
      );
    else
      execute format(
        'create policy tenant_insert on public.%I for insert to authenticated with check (public.can_insert_organization_data(organization_id, %L))',
        item.table_name, item.data_key
      );
    end if;
    execute format(
      'create policy tenant_update on public.%I for update to authenticated using (public.can_write_organization(organization_id, %L)) with check (public.can_write_organization(organization_id, %L))',
      item.table_name, item.data_key, item.data_key
    );
    execute format(
      'create policy tenant_delete on public.%I for delete to authenticated using (public.can_write_organization(organization_id, %L))',
      item.table_name, item.data_key
    );
  end loop;
end
$$;

create or replace function public.validate_ledger_category_type()
returns trigger
language plpgsql set search_path = '' as $$
declare
  expected_type text;
  actual_type text;
begin
  if auth.role() <> 'service_role' and not public.can_access_organization(new.organization_id) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  expected_type := case tg_table_name
    when 'credit_sales' then 'income'
    when 'budget_items' then 'expense'
    else new.transaction_type
  end;
  select c.category_type into actual_type
    from public.categories c
    where c.organization_id = new.organization_id and c.id = new.category_id;
  if actual_type is distinct from expected_type then
    raise exception 'Category type does not match this ledger record.' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists transactions_category_type_check on public.transactions;
create trigger transactions_category_type_check before insert or update of organization_id, category_id, transaction_type
  on public.transactions for each row execute function public.validate_ledger_category_type();
drop trigger if exists credit_sales_category_type_check on public.credit_sales;
create trigger credit_sales_category_type_check before insert or update of organization_id, category_id
  on public.credit_sales for each row execute function public.validate_ledger_category_type();
drop trigger if exists budget_items_category_type_check on public.budget_items;
create trigger budget_items_category_type_check before insert or update of organization_id, category_id
  on public.budget_items for each row execute function public.validate_ledger_category_type();

create or replace function public.claim_org_data_version(p_organization_id uuid, p_data_key text, p_expected_version bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare next_version bigint;
begin
  if not public.can_insert_organization_data(p_organization_id, p_data_key) then raise exception 'Forbidden'; end if;
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
