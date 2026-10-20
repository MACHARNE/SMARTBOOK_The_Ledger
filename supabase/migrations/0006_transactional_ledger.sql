-- Transactional, versioned writes and authoritative financial operations.
-- Existing financial history is preserved. New writes generate trusted audit events.
-- Use JSON access for the shared trigger: credit/budget rows do not contain
-- transaction_type, even when another CASE branch would be selected.
create or replace function public.validate_ledger_category_type() returns trigger
language plpgsql set search_path='' as $$
declare expected_type text; actual_type text;
begin
  if auth.role()<>'service_role' and not public.can_access_organization(new.organization_id) then raise exception 'Forbidden' using errcode='42501'; end if;
  expected_type:=case tg_table_name when 'credit_sales' then 'income' when 'budget_items' then 'expense' else to_jsonb(new)->>'transaction_type' end;
  select category_type into actual_type from public.categories where organization_id=new.organization_id and id=new.category_id;
  if actual_type is distinct from expected_type then raise exception 'Category type does not match this ledger record.' using errcode='23514'; end if;
  return new;
end $$;

create table public.ledger_operations (
  organization_id uuid not null references public.organizations(id),
  request_id uuid not null,
  action text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (organization_id, request_id)
);
alter table public.ledger_operations enable row level security;
create policy tenant_select on public.ledger_operations for select to authenticated using(public.can_access_organization(organization_id));
grant select on public.ledger_operations to authenticated;
grant all on public.ledger_operations to service_role;

alter table public.transactions add column source_kind text;
alter table public.transactions add column source_id text;
create unique index transaction_source_uidx on public.transactions(organization_id,source_kind,source_id) where source_id is not null;
alter table public.transactions add constraint transaction_payload_consistent check(
  coalesce(payload->>'id'=id and payload->>'date'=date::text and payload->>'type'=transaction_type and payload->>'category'=category_id and (payload->>'amount')::numeric=amount,false)
) not valid;
alter table public.credit_sales add constraint credit_payload_consistent check(
  coalesce(payload->>'id'=id and payload->>'date'=sale_date::text and payload->>'status'=status and payload->>'category'=category_id and (payload->>'amount')::numeric=amount,false)
) not valid;
alter table public.dispatches add constraint dispatch_payload_consistent check(
  coalesce(payload->>'id'=id and payload->>'date'=dispatch_date::text and payload->>'status'=status and (payload->>'productAmount')::numeric=product_amount and (payload->>'deliveryAmount')::numeric=delivery_amount,false)
) not valid;
alter table public.stock_movements add constraint movement_payload_consistent check(
  coalesce(payload->>'id'=id and payload->>'itemId'=item_id and payload->>'date'=movement_date::text and payload->>'type'=movement_type and (payload->>'quantity')::numeric=quantity,false)
) not valid;
create table public.budget_retirements (
  organization_id uuid not null,
  id text not null,
  budget_item_id text not null,
  transaction_id text not null,
  amount numeric(14,2) not null check(amount>0),
  note text not null default '',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  primary key(organization_id,id),
  foreign key(organization_id,budget_item_id) references public.budget_items(organization_id,id),
  foreign key(organization_id,transaction_id) references public.transactions(organization_id,id),
  unique(organization_id,transaction_id)
);
alter table public.budget_retirements enable row level security;
create policy tenant_select on public.budget_retirements for select to authenticated using(public.can_access_organization(organization_id));
grant select on public.budget_retirements to authenticated;
grant all on public.budget_retirements to service_role;

update public.org_settings set payload=payload-'approverPin';
alter table public.categories add column report_class text;
update public.categories set report_class=case when category_type='expense' then null when id in ('booking_sales','direct_sales') then 'sales' else 'other_income' end;
alter table public.categories add constraint category_report_class check(report_class is null or (category_type='income' and report_class in ('sales','other_income')));

create function public.ledger_audit_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare before_row jsonb; after_row jsonb; org_id uuid; record_id text; event_id text:=gen_random_uuid()::text;
begin
  if tg_op<>'INSERT' then before_row:=to_jsonb(old); end if;
  if tg_op<>'DELETE' then after_row:=to_jsonb(new); end if;
  org_id:=coalesce((after_row->>'organization_id')::uuid,(before_row->>'organization_id')::uuid);
  if not exists(select 1 from public.organizations where id=org_id) then return coalesce(new,old); end if;
  record_id:=coalesce(after_row->>'id',before_row->>'id',org_id::text);
  if tg_table_name='org_settings' then before_row:=before_row-'payload'; after_row:=after_row-'payload'; end if;
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,app_record_id,details,payload)
  values(org_id,auth.uid(),lower(tg_op),tg_table_name,record_id,event_id,
    jsonb_build_object('before',before_row,'after',after_row),
    jsonb_build_object('id',event_id,'timestamp',now(),'action',lower(tg_op)||' '||tg_table_name,'detail','Record '||record_id,'actorId',auth.uid()));
  return coalesce(new,old);
end $$;
revoke all on function public.ledger_audit_change() from public,anon,authenticated;
do $$ declare t text; begin
  foreach t in array array['business_profiles','org_settings','categories','transactions','credit_sales','credit_payments','budgets','budget_items','stock_items','stock_movements','commission_roles','workers','dispatches','vendor_remittances','commission_payments','budget_retirements'] loop
    execute format('create trigger ledger_audit after insert or update or delete on public.%I for each row execute function public.ledger_audit_change()',t);
    execute format('revoke insert,update,delete on public.%I from authenticated,anon',t);
  end loop;
end $$;
drop policy if exists audit_member_insert on public.audit_events;
revoke insert,update,delete on public.audit_events from authenticated,anon;
revoke execute on function public.claim_org_data_version(uuid,text,bigint) from authenticated;

create function public.read_ledger_data(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb:='{}'; table_name text; key_name text; value jsonb;
begin
  if not public.can_access_organization(p_org) then raise exception 'Forbidden' using errcode='42501'; end if;
  for key_name,table_name in select * from (values('transactions','transactions'),('credit_sales','credit_sales'),('stock_items','stock_items'),('stock_movements','stock_movements'),('roles','commission_roles'),('workers','workers'),('dispatches','dispatches')) t(k,v) loop
    execute format('select coalesce(jsonb_agg(payload order by id),''[]''::jsonb) from public.%I where organization_id=$1',table_name) into value using p_org;
    result:=result||jsonb_build_object(key_name,value);
  end loop;
  select jsonb_build_object('income',coalesce(jsonb_agg(payload||jsonb_build_object('reportClass',report_class) order by id) filter(where category_type='income'),'[]'),
    'expense',coalesce(jsonb_agg(payload order by id) filter(where category_type='expense'),'[]')) into value from public.categories where organization_id=p_org;
  result:=result||jsonb_build_object('categories',value);
  select coalesce(jsonb_agg(b.payload||jsonb_build_object('items',coalesce((select jsonb_agg(i.payload order by i.id) from public.budget_items i where i.organization_id=p_org and i.budget_id=b.id),'[]')) order by b.created_at desc),'[]') into value from public.budgets b where b.organization_id=p_org;
  result:=result||jsonb_build_object('budgets',value);
  result:=result||jsonb_build_object('business_profile',(select payload from public.business_profiles where organization_id=p_org),'gov_settings',coalesce((select payload-'approverPin' from public.org_settings where organization_id=p_org),'{}'));
  select coalesce(jsonb_agg(payload order by created_at desc),'[]') into value from public.audit_events where organization_id=p_org and app_record_id is not null;
  result:=result||jsonb_build_object('log_trail',value);
  return jsonb_build_object('data',result,'versions',coalesce((select jsonb_object_agg(data_key,version) from public.org_data_versions where organization_id=p_org),'{}'));
end $$;
revoke all on function public.read_ledger_data(uuid) from public,anon;
grant execute on function public.read_ledger_data(uuid) to authenticated;

-- Only the following server-side functions can call this helper. Table names
-- and columns come from fixed mappings, never from client SQL.
create function public.sync_ledger_rows(p_org uuid,p_table text,p_rows jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare columns_list text; update_list text; old_row jsonb;
begin
  columns_list:=case p_table
    when 'transactions' then 'organization_id,id,date,transaction_type,category_id,amount,invoice_number,invoice_issued_at,payload,source_kind,source_id'
    when 'credit_sales' then 'organization_id,id,category_id,sale_date,amount,status,payload'
    when 'credit_payments' then 'organization_id,id,credit_sale_id,payment_date,amount,payment_method,payload'
    when 'categories' then 'organization_id,id,category_type,label,cogs,report_class,payload'
    when 'budgets' then 'organization_id,id,title,created_at,payload'
    when 'budget_items' then 'organization_id,id,budget_id,category_id,amount_requested,status,payload'
    when 'stock_items' then 'organization_id,id,name,unit,payload'
    when 'stock_movements' then 'organization_id,id,item_id,movement_date,movement_type,quantity,payload'
    when 'commission_roles' then 'organization_id,id,name,commission_type,rate,payload'
    when 'workers' then 'organization_id,id,role_id,name,phone,payload'
    when 'dispatches' then 'organization_id,id,dispatch_date,status,product_amount,delivery_amount,dispatcher_id,bdo_id,payload'
    when 'vendor_remittances' then 'organization_id,id,dispatch_id,payment_date,amount,payment_method,payload'
    when 'commission_payments' then 'organization_id,id,worker_id,payment_date,amount,payment_method,payload'
    else null end;
  if columns_list is null or jsonb_typeof(p_rows)<>'array' then raise exception 'Invalid collection'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where nullif(r->>'id','') is null or (r->>'organization_id')::uuid<>p_org) then raise exception 'Invalid record identity'; end if;
  if (select count(*)<>count(distinct r->>'id') from jsonb_array_elements(p_rows) r) then raise exception 'Duplicate record IDs'; end if;
  select string_agg(format('%I=excluded.%I',c,c),',') into update_list from unnest(string_to_array(columns_list,',')) c where c not in ('organization_id','id');
  execute format('delete from public.%I where organization_id=$1 and id not in (select r->>''id'' from jsonb_array_elements($2) r)',p_table) using p_org,p_rows;
  execute format('insert into public.%I as target (%s) select %s from jsonb_populate_recordset(null::public.%I,$1) on conflict(organization_id,id) do update set %s where target.payload is distinct from excluded.payload',p_table,columns_list,columns_list,p_table,update_list) using p_rows;
end $$;
revoke all on function public.sync_ledger_rows(uuid,text,jsonb) from public,anon,authenticated;

create function public.commit_ledger_data(p_org uuid,p_expected jsonb,p_changes jsonb,p_financial boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare key_name text; items jsonb; rows jsonb; children jsonb; item jsonb; parent jsonb; old_payload jsonb; table_name text; member_role text; current_version bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org::text,0));
  select m.role into member_role from public.organization_members m join public.organizations o on o.id=m.organization_id where m.organization_id=p_org and m.user_id=auth.uid() and m.status='active' and o.status='active';
  if member_role is null or member_role='viewer' then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_expected is null or jsonb_typeof(p_expected)<>'object' then raise exception 'Expected versions are required'; end if;
  if p_changes is null or jsonb_typeof(p_changes)<>'object' or p_changes='{}' then raise exception 'No changes supplied'; end if;
  for key_name,items in select key,value from jsonb_each(p_changes) order by key loop
    if not key_name=any(array['transactions','credit_sales','budgets','categories','business_profile','gov_settings','stock_items','stock_movements','roles','workers','dispatches']) then raise exception 'Unsupported data collection'; end if;
    select version into current_version from public.org_data_versions where organization_id=p_org and data_key=key_name;
    if p_expected->>key_name is null or coalesce(current_version,0)<>(p_expected->>key_name)::bigint then raise exception 'This data changed in another session. Reload before saving.' using errcode='40001'; end if;
    if member_role='staff' and key_name not in ('transactions','credit_sales','dispatches') then raise exception 'Forbidden' using errcode='42501'; end if;
    if key_name='stock_items' and not(p_changes ? 'stock_movements') and exists(select 1 from public.stock_movements m where m.organization_id=p_org and not exists(select 1 from jsonb_array_elements(items) i where i->>'id'=m.item_id)) then raise exception 'Remove the stock item and its movements together'; end if;
    if key_name in ('business_profile','gov_settings') then
      if jsonb_typeof(items)<>'object' then raise exception 'Expected settings object'; end if;
      if key_name='business_profile' then insert into public.business_profiles(organization_id,payload) values(p_org,items) on conflict(organization_id) do update set payload=excluded.payload;
      else insert into public.org_settings(organization_id,payload) values(p_org,items-'approverPin') on conflict(organization_id) do update set payload=excluded.payload; end if;
    else
      rows:='[]'; children:='[]';
      if key_name='categories' then
        for table_name in select unnest(array['income','expense']) loop
          for item in select value from jsonb_array_elements(items->table_name) loop
            item:=item||jsonb_build_object('reportClass',case when table_name='income' then coalesce(item->>'reportClass',case when item->>'id' in ('booking_sales','direct_sales') then 'sales' else 'other_income' end) else null end);
            rows:=rows||jsonb_build_array(jsonb_build_object('organization_id',p_org,'id',item->>'id','category_type',table_name,'label',item->>'label','cogs',table_name='expense' and coalesce((item->>'cogs')::boolean,false),'report_class',item->>'reportClass','payload',item));
          end loop;
        end loop;
        perform public.sync_ledger_rows(p_org,'categories',rows);
      else
        if jsonb_typeof(items)<>'array' then raise exception 'Expected collection array'; end if;
        table_name:=case key_name when 'roles' then 'commission_roles' else key_name end;
        -- Basic saves cannot alter financial workflow state, even by a manager.
        if not p_financial and key_name in ('transactions','credit_sales','dispatches','budgets') then
          for item in select value from jsonb_array_elements(items) loop
            execute format('select payload from public.%I where organization_id=$1 and id=$2',table_name) into old_payload using p_org,item->>'id';
            if member_role='staff' and old_payload is not null and old_payload is distinct from item then raise exception 'Staff cannot edit existing records'; end if;
            if key_name='transactions' then
              if member_role='staff' and old_payload is null and (item->>'type'<>'income' or item ? 'creditId' or item ? 'dispatchId') then raise exception 'Staff can record ordinary income only'; end if;
              if (item ? 'creditId' or item ? 'dispatchId' or item ? 'sourceKind' or old_payload ? 'sourceKind' or old_payload ? 'creditId' or old_payload ? 'dispatchId') and (item-'invoiceNo'-'invoiceIssuedAt') is distinct from (old_payload-'invoiceNo'-'invoiceIssuedAt') then raise exception 'Linked financial records cannot be changed'; end if;
            elsif key_name='credit_sales' then
              if old_payload->>'status'='paid' and item is distinct from old_payload then raise exception 'Settled credit cannot be changed'; end if;
              if item->>'status'='paid' and old_payload->>'status' is distinct from 'paid' then raise exception 'Use the credit settlement action'; end if;
            elsif key_name='dispatches' then
              if old_payload->>'status'='delivered' and item is distinct from old_payload then raise exception 'Completed delivery cannot be changed'; end if;
              if old_payload is null and (item->>'status'<>'yet_to_deliver' or coalesce((item->>'dispatcherCommissionPaid')::boolean,false) or coalesce((item->>'bdoCommissionPaid')::boolean,false)) then raise exception 'New deliveries must be drafts'; end if;
              if old_payload is not null and (item-'status') is distinct from (old_payload-'status') then raise exception 'Use a delivery financial action'; end if;
              if item->>'status'='delivered' and old_payload->>'status' is distinct from 'delivered' then raise exception 'Use the delivery completion action'; end if;
            elsif key_name='budgets' then
              for parent in select value from jsonb_array_elements(item->'items') loop
                if (parent->>'status'<>'pending' or jsonb_array_length(coalesce(parent->'retirements','[]'))>0) and not exists(select 1 from public.budget_items b where b.organization_id=p_org and b.id=parent->>'id' and b.payload=parent) then raise exception 'Use the budget decision or retirement action'; end if;
              end loop;
            end if;
          end loop;
          -- Full snapshots cannot silently remove protected or staff-owned history.
          if member_role='staff' then
            execute format('select exists(select 1 from public.%I where organization_id=$1 and id not in(select r->>''id'' from jsonb_array_elements($2) r))',table_name) into p_financial using p_org,items;
            if p_financial then raise exception 'Staff cannot remove records'; end if;
            p_financial:=false;
          end if;
          if key_name='transactions' and exists(select 1 from public.transactions t where t.organization_id=p_org and (t.payload ? 'sourceKind' or t.payload ? 'creditId' or t.payload ? 'dispatchId') and not exists(select 1 from jsonb_array_elements(items) r where r->>'id'=t.id)) then raise exception 'Linked financial records cannot be deleted'; end if;
          if key_name='credit_sales' and exists(select 1 from public.credit_sales t where t.organization_id=p_org and t.status='paid' and not exists(select 1 from jsonb_array_elements(items) r where r->>'id'=t.id)) then raise exception 'Settled credit cannot be deleted'; end if;
          if key_name='dispatches' and exists(select 1 from public.dispatches t where t.organization_id=p_org and t.status='delivered' and not exists(select 1 from jsonb_array_elements(items) r where r->>'id'=t.id)) then raise exception 'Completed deliveries cannot be deleted'; end if;
          if key_name='budgets' and exists(select 1 from public.budget_items t where t.organization_id=p_org and t.status<>'pending' and not exists(select 1 from jsonb_array_elements(items) b cross join lateral jsonb_array_elements(b->'items') i where i->>'id'=t.id and i=t.payload)) then raise exception 'Decided budget items cannot be changed or removed'; end if;
        end if;
        for item in select value from jsonb_array_elements(items) loop
          if key_name in ('transactions','credit_sales') then item:=jsonb_set(item,'{amount}',to_jsonb(round((item->>'amount')::numeric,2))); end if;
          if key_name='dispatches' then item:=item||jsonb_build_object('productAmount',round((item->>'productAmount')::numeric,2),'deliveryAmount',round((item->>'deliveryAmount')::numeric,2)); end if;
          if key_name='stock_movements' then item:=jsonb_set(item,'{quantity}',to_jsonb(round((item->>'quantity')::numeric,3))); end if;
          if key_name='dispatches' and not p_financial and not exists(select 1 from public.dispatches where organization_id=p_org and id=item->>'id') then
            item:=item||jsonb_build_object('vendorOwed',0,'vendorRemitStatus',null,'vendorRemitDate','','vendorRemitMethod','','dispatcherCommission',0,'dispatcherCommissionPaid',false,'bdoCommission',0,'bdoCommissionPaid',false,'deliveredAt','');
          end if;
          parent:=jsonb_build_object('organization_id',p_org,'id',item->>'id','payload',item);
          case key_name
            when 'transactions' then parent:=parent||jsonb_build_object('date',item->>'date','transaction_type',item->>'type','category_id',item->>'category','amount',item->'amount','invoice_number',item->>'invoiceNo','invoice_issued_at',item->>'invoiceIssuedAt','source_kind',item->>'sourceKind','source_id',item->>'sourceId');
            when 'credit_sales' then parent:=parent||jsonb_build_object('sale_date',item->>'date','category_id',item->>'category','amount',item->'amount','status',item->>'status');
            when 'stock_items' then parent:=parent||jsonb_build_object('name',item->>'name','unit',coalesce(item->>'unit','units'));
            when 'stock_movements' then parent:=parent||jsonb_build_object('item_id',item->>'itemId','movement_date',item->>'date','movement_type',item->>'type','quantity',item->'quantity');
            when 'roles' then parent:=parent||jsonb_build_object('name',item->>'name','commission_type',item->>'commissionType','rate',item->'rate');
            when 'workers' then parent:=parent||jsonb_build_object('role_id',item->>'roleId','name',item->>'name','phone',item->>'phone');
            when 'dispatches' then parent:=parent||jsonb_build_object('dispatch_date',item->>'date','status',item->>'status','product_amount',item->'productAmount','delivery_amount',item->'deliveryAmount','dispatcher_id',nullif(item->>'dispatcherId',''),'bdo_id',nullif(item->>'bdoId',''));
            when 'budgets' then
              parent:=parent||jsonb_build_object('title',item->>'title','created_at',item->>'createdAt','payload',item-'items');
              select children||coalesce(jsonb_agg(jsonb_build_object('organization_id',p_org,'id',i->>'id','budget_id',item->>'id','category_id',i->>'category','amount_requested',i->'amountRequested','status',i->>'status','payload',i)),'[]') into children from jsonb_array_elements(item->'items') i;
            else raise exception 'Unsupported collection';
          end case;
          rows:=rows||jsonb_build_array(parent);
        end loop;
        perform public.sync_ledger_rows(p_org,table_name,rows);
        if key_name='budgets' then perform public.sync_ledger_rows(p_org,'budget_items',children); end if;
      end if;
    end if;
    insert into public.org_data_versions(organization_id,data_key,version) values(p_org,key_name,1) on conflict(organization_id,data_key) do update set version=public.org_data_versions.version+1;
  end loop;
  return public.read_ledger_data(p_org);
end $$;
revoke all on function public.commit_ledger_data(uuid,jsonb,jsonb,boolean) from public,anon,authenticated;
create function public.save_ledger_data(p_org uuid,p_expected jsonb,p_changes jsonb) returns jsonb
language sql security definer set search_path='' as $$ select public.commit_ledger_data(p_org,p_expected,p_changes,false) $$;
revoke all on function public.save_ledger_data(uuid,jsonb,jsonb) from public,anon;
grant execute on function public.save_ledger_data(uuid,jsonb,jsonb) to authenticated;

create function public.patch_ledger_array(p_items jsonb,p_id text,p_patch jsonb) returns jsonb
language sql immutable set search_path='' as $$ select coalesce(jsonb_agg(case when i->>'id'=p_id then i||p_patch else i end),'[]') from jsonb_array_elements(p_items) i $$;
revoke all on function public.patch_ledger_array(jsonb,text,jsonb) from public,anon,authenticated;

create function public.perform_ledger_action(p_org uuid,p_action text,p_input jsonb,p_expected jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare snapshot jsonb; data jsonb; changes jsonb:='{}'; record jsonb; item jsonb; patch jsonb; tx jsonb; entry jsonb; worker_row record; category_id text; member_role text; total numeric:=0; amount numeric; remaining numeric; vendor_amount numeric; dispatcher_amount numeric:=0; bdo_amount numeric:=0; payment_day date; tx_id text:=gen_random_uuid()::text; item_id text; key_name text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org::text,0));
  select m.role into member_role from public.organization_members m join public.organizations o on o.id=m.organization_id where m.organization_id=p_org and m.user_id=auth.uid() and m.status='active' and o.status='active';
  if member_role not in ('owner','accountant') or member_role is null then raise exception 'Owner or accountant access required' using errcode='42501'; end if;
  if p_request_id is null then raise exception 'Request ID required'; end if;
  if exists(select 1 from public.ledger_operations where organization_id=p_org and request_id=p_request_id and created_by=auth.uid() and action=p_action) then return public.read_ledger_data(p_org); end if;
  if p_expected is null or jsonb_typeof(p_expected)<>'object' or p_input is null or jsonb_typeof(p_input)<>'object' then raise exception 'Expected versions and action input are required'; end if;
  snapshot:=public.read_ledger_data(p_org); data:=snapshot->'data';
  -- Reject stale inputs before computing effects, including all read dependencies.
  for key_name in select jsonb_object_keys(snapshot->'versions') loop
    if coalesce((p_expected->>key_name)::bigint,0)<>((snapshot->'versions')->>key_name)::bigint then raise exception 'This data changed in another session. Reload before saving.' using errcode='40001'; end if;
  end loop;
  payment_day:=coalesce(nullif(p_input->>'date','')::date,(now() at time zone 'Africa/Lagos')::date);
  if p_action='settle_credit' then
    select payload into record from public.credit_sales where organization_id=p_org and id=p_input->>'id' for update;
    if record is null or record->>'status'<>'outstanding' then raise exception 'Credit is missing or already settled'; end if;
    amount:=(record->>'amount')::numeric; category_id:=record->>'category';
    tx:=jsonb_build_object('creditId',record->>'id','description','Credit payment — '||coalesce(record->>'customerName','customer'),'sourceKind','credit_settlement','sourceId',record->>'id','type','income');
    changes:=jsonb_build_object('credit_sales',public.patch_ledger_array(data->'credit_sales',record->>'id',jsonb_build_object('status','paid','paidDate',payment_day,'paidMethod',p_input->>'method')));
    insert into public.credit_payments(organization_id,id,credit_sale_id,payment_date,amount,payment_method,payload) values(p_org,record->>'id',record->>'id',payment_day,amount,p_input->>'method',jsonb_build_object('transactionId',tx_id));
  elsif p_action in ('complete_dispatch','remit_vendor') then
    select payload into record from public.dispatches where organization_id=p_org and id=p_input->>'id' for update;
    if record is null then raise exception 'Delivery not found'; end if;
    if p_action='remit_vendor' then
      if record->>'status'<>'delivered' or record->>'vendorRemitStatus'<>'pending' then raise exception 'No vendor remittance is pending'; end if;
      amount:=(record->>'vendorOwed')::numeric;
      insert into public.vendor_remittances(organization_id,id,dispatch_id,payment_date,amount,payment_method,payload) values(p_org,record->>'id',record->>'id',payment_day,amount,p_input->>'method',jsonb_build_object('recordedBy',auth.uid()));
      changes:=jsonb_build_object('dispatches',public.patch_ledger_array(data->'dispatches',record->>'id',jsonb_build_object('vendorRemitStatus','remitted','vendorRemitDate',payment_day,'vendorRemitMethod',p_input->>'method')));
    else
      if record->>'status' not in ('yet_to_deliver','on_transit') then raise exception 'Delivery is already completed or returned'; end if;
      amount:=(record->>'deliveryAmount')::numeric;
      vendor_amount:=greatest((record->>'productAmount')::numeric-case when coalesce((record->>'chargeIncluded')::boolean,false) then amount else 0 end,0);
      for worker_row in select w.id,r.commission_type,r.rate from public.workers w join public.commission_roles r on r.organization_id=w.organization_id and r.id=w.role_id where w.organization_id=p_org and w.id in (record->>'dispatcherId',record->>'bdoId') loop
        total:=round(case when worker_row.commission_type='flat' then worker_row.rate else amount*worker_row.rate/100 end,2);
        if worker_row.id=record->>'dispatcherId' then dispatcher_amount:=total; end if;
        if worker_row.id=record->>'bdoId' then bdo_amount:=total; end if;
      end loop;
      select id into category_id from public.categories where organization_id=p_org and category_type='income' and coalesce(report_class,'sales')='other_income' order by id limit 1;
      if category_id is null then select id into category_id from public.categories where organization_id=p_org and category_type='income' order by id limit 1; end if;
      tx:=jsonb_build_object('dispatchId',record->>'id','description','Delivery service charge — '||coalesce(record->>'productName','delivery'),'sourceKind','delivery_income','sourceId',record->>'id','type','income');
      changes:=jsonb_build_object('dispatches',public.patch_ledger_array(data->'dispatches',record->>'id',jsonb_build_object('status','delivered','deliveredAt',payment_day,'vendorOwed',vendor_amount,'vendorRemitStatus',case when vendor_amount>0 then 'pending' else 'none' end,'dispatcherCommission',dispatcher_amount,'bdoCommission',bdo_amount)));
    end if;
  elsif p_action='pay_commission' then
    select payload into record from public.workers where organization_id=p_org and id=p_input->>'id';
    if record is null then raise exception 'Worker not found'; end if;
    entry:=data->'dispatches'; total:=0;
    for item in select payload from public.dispatches where organization_id=p_org and status='delivered' for update loop
      patch:='{}';
      for key_name in select unnest(array['dispatcher','bdo']) loop
        if item->>(key_name||'Id')=p_input->>'id' and not coalesce((item->>(key_name||'CommissionPaid'))::boolean,false) and (item->>(key_name||'Commission'))::numeric>0 then
          amount:=(item->>(key_name||'Commission'))::numeric; total:=total+amount;
          insert into public.commission_payments(organization_id,id,worker_id,payment_date,amount,payment_method,payload) values(p_org,(item->>'id')||':'||key_name,p_input->>'id',payment_day,amount,p_input->>'method',jsonb_build_object('dispatchId',item->>'id','role',key_name,'transactionId',tx_id));
          patch:=patch||jsonb_build_object(key_name||'CommissionPaid',true);
        end if;
      end loop;
      entry:=public.patch_ledger_array(entry,item->>'id',patch);
    end loop;
    if total<=0 then raise exception 'No unpaid commission'; end if;
    amount:=total;
    select id into category_id from public.categories where organization_id=p_org and category_type='expense' and not cogs order by id limit 1;
    tx:=jsonb_build_object('description','Commission paid — '||coalesce(record->>'name','worker'),'sourceKind','commission_payment','sourceId',p_request_id,'type','expense');
    changes:=jsonb_build_object('dispatches',entry);
  elsif p_action in ('decide_budget','retire_budget') then
    select payload into record from public.budgets where organization_id=p_org and id=p_input->>'budgetId' for update;
    select payload into item from public.budget_items where organization_id=p_org and budget_id=p_input->>'budgetId' and id=p_input->>'id' for update;
    if record is null or item is null then raise exception 'Budget item not found'; end if;
    if p_action='decide_budget' then
      if member_role<>'owner' then raise exception 'Only the organization owner can decide budgets' using errcode='42501'; end if;
      if item->>'status'<>'pending' or p_input->>'decision' not in ('approved','rejected') then raise exception 'Invalid budget decision'; end if;
      if p_input->>'decision'='rejected' and nullif(trim(p_input->>'reason'),'') is null then raise exception 'A rejection reason is required'; end if;
      patch:=jsonb_build_object('status',p_input->>'decision','decidedAt',now(),'decidedBy',auth.uid(),'rejectReason',coalesce(p_input->>'reason',''));
    else
      if item->>'status'<>'approved' then raise exception 'Only approved items can be retired'; end if;
      amount:=round((p_input->>'amount')::numeric,2);
      if amount is null or amount<=0 then raise exception 'Positive amount required'; end if;
      select (item->>'amountRequested')::numeric-coalesce(sum((r->>'amount')::numeric),0) into remaining from jsonb_array_elements(coalesce(item->'retirements','[]')) r;
      if amount>remaining and nullif(trim(p_input->>'note'),'') is null then raise exception 'An overspend reason is required'; end if;
      patch:=jsonb_build_object('retirements',coalesce(item->'retirements','[]')||jsonb_build_array(jsonb_build_object('id',p_request_id,'date',payment_day,'amount',amount,'method',p_input->>'method','note',coalesce(p_input->>'note',''),'recordedBy',auth.uid(),'recordedAt',now(),'transactionId',tx_id)));
      category_id:=item->>'category';
      tx:=jsonb_build_object('description','Budget retirement — '||(record->>'title'),'sourceKind','budget_retirement','sourceId',p_request_id,'type','expense');
    end if;
    select coalesce(jsonb_agg(case when b->>'id'=p_input->>'budgetId' then b||jsonb_build_object('items',public.patch_ledger_array(b->'items',item->>'id',patch)) else b end),'[]') into entry from jsonb_array_elements(data->'budgets') b;
    changes:=jsonb_build_object('budgets',entry);
  elsif p_action='procure' then
    amount:=round((p_input->>'amount')::numeric,2); category_id:=p_input->>'category';
    if not exists(select 1 from public.categories where organization_id=p_org and id=category_id and category_type='expense' and cogs) then raise exception 'A procurement COGS category is required'; end if;
    tx:=jsonb_build_object('description',concat_ws(' — ',nullif(p_input->>'supplier',''),nullif(p_input->>'description','')),'sourceKind','procurement','sourceId',p_request_id,'type','expense');
    if nullif(p_input->>'stockItemId','') is not null then
      if (p_input->>'quantity')::numeric is null or (p_input->>'quantity')::numeric<=0 then raise exception 'Positive stock quantity required'; end if;
      changes:=jsonb_build_object('stock_movements',(data->'stock_movements')||jsonb_build_array(jsonb_build_object('id',p_request_id,'itemId',p_input->>'stockItemId','date',payment_day,'type','in','quantity',(p_input->>'quantity')::numeric,'note','Procurement','recordedBy',auth.uid(),'createdAt',now())));
    end if;
  else raise exception 'Unsupported financial action'; end if;
  if tx is not null then
    if amount is null or amount<=0 or category_id is null then raise exception 'Positive amount and matching category required'; end if;
    tx:=tx||jsonb_build_object('id',tx_id,'date',payment_day,'category',category_id,'amount',amount,'method',coalesce(p_input->>'method','Cash'),'requestedBy',auth.uid());
    changes:=changes||jsonb_build_object('transactions',jsonb_build_array(tx)||(data->'transactions'));
  end if;
  -- Populate absent version keys explicitly for new collections.
  for key_name in select jsonb_object_keys(changes) loop p_expected:=p_expected||jsonb_build_object(key_name,coalesce((p_expected->>key_name)::bigint,0)); end loop;
  perform public.commit_ledger_data(p_org,p_expected,changes,true);
  if p_action='retire_budget' then insert into public.budget_retirements(organization_id,id,budget_item_id,transaction_id,amount,note,created_by) values(p_org,p_request_id::text,p_input->>'id',tx_id,amount,coalesce(p_input->>'note',''),auth.uid()); end if;
  insert into public.ledger_operations(organization_id,request_id,action,created_by) values(p_org,p_request_id,p_action,auth.uid());
  return public.read_ledger_data(p_org);
end $$;
revoke all on function public.perform_ledger_action(uuid,text,jsonb,jsonb,uuid) from public,anon;
grant execute on function public.perform_ledger_action(uuid,text,jsonb,jsonb,uuid) to authenticated;

-- Both the API and the database require super-admin authority for lifecycle decisions.
create function public.is_super_admin(p_uid uuid) returns boolean language sql stable security definer set search_path='' as $$
  select (p_uid=auth.uid() or auth.role()='service_role') and exists(select 1 from public.platform_admins where user_id=p_uid and role='super_admin')
$$;
revoke all on function public.is_super_admin(uuid) from public,anon;
grant execute on function public.is_super_admin(uuid) to authenticated,service_role;
drop policy if exists audit_org_read on public.audit_events;
create policy audit_org_read on public.audit_events for select to authenticated using((organization_id is not null and public.can_access_organization(organization_id)) or public.is_super_admin(auth.uid()));
alter function public.decide_organization_request(uuid,uuid,text,text) rename to decide_organization_request_internal;
revoke all on function public.decide_organization_request_internal(uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.decide_organization_request(p_actor_id uuid,p_request_id uuid,p_decision text,p_reason text default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.is_super_admin(p_actor_id) then raise exception 'Forbidden' using errcode='42501'; end if;
  return public.decide_organization_request_internal(p_actor_id,p_request_id,p_decision,p_reason);
end $$;
revoke all on function public.decide_organization_request(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.decide_organization_request(uuid,uuid,text,text) to service_role;

create function public.provision_company_owner(p_actor_id uuid,p_user_id uuid,p_company_name text,p_contact_name text,p_email text,p_phone text default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare org_id uuid;
begin
  if not public.is_super_admin(p_actor_id) then raise exception 'Forbidden' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(lower(p_email)||':'||lower(p_company_name),0));
  select organization_id into org_id from public.organization_signup_requests where lower(email)=lower(p_email) and lower(company_name)=lower(p_company_name) and requester_user_id=p_user_id;
  if org_id is not null then return org_id; end if;
  insert into public.organizations(name,status) values(p_company_name,'pending') returning id into org_id;
  insert into public.organization_members(organization_id,user_id,role,status,invited_by) values(org_id,p_user_id,'owner','invited',p_actor_id);
  insert into public.organization_signup_requests(organization_id,requester_user_id,company_name,contact_name,email,phone) values(org_id,p_user_id,p_company_name,p_contact_name,p_email,p_phone);
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,details) values(org_id,p_actor_id,'company_owner_invited','organization',org_id::text,jsonb_build_object('email',p_email));
  return org_id;
end $$;
revoke all on function public.provision_company_owner(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.provision_company_owner(uuid,uuid,text,text,text,text) to service_role;

create function public.provision_platform_admin(p_actor_id uuid,p_user_id uuid,p_role text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if not public.is_super_admin(p_actor_id) or p_role not in ('admin','super_admin') then raise exception 'Forbidden' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-admin-provisioning',0));
  if p_role='admin' and exists(select 1 from public.platform_admins where user_id=p_user_id and role='super_admin') and not exists(select 1 from public.platform_admins where user_id<>p_user_id and role='super_admin') then raise exception 'The last super admin cannot be demoted'; end if;
  insert into public.platform_admins(user_id,role,created_by) values(p_user_id,p_role,p_actor_id) on conflict(user_id) do update set role=excluded.role;
  insert into public.audit_events(actor_user_id,action,entity_type,entity_id,details) values(p_actor_id,'platform_admin_invited','platform_admin',p_user_id::text,jsonb_build_object('role',p_role));
end $$;
revoke all on function public.provision_platform_admin(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.provision_platform_admin(uuid,uuid,text) to service_role;

alter function public.set_member_status(uuid,uuid,uuid,text,text) rename to set_member_status_internal;
revoke all on function public.set_member_status_internal(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.set_member_status(p_actor_id uuid,p_org_id uuid,p_user_id uuid,p_status text,p_role text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare previous public.organization_members%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text,0));
  select * into previous from public.organization_members where organization_id=p_org_id and user_id=p_user_id;
  if previous.role='owner' and previous.status='active' and (p_status<>'active' or coalesce(p_role,'owner')<>'owner') and not exists(select 1 from public.organization_members where organization_id=p_org_id and user_id<>p_user_id and role='owner' and status='active') then raise exception 'The last active owner cannot be removed or demoted'; end if;
  if previous.status='active' and p_status='invited' then return to_jsonb(previous); end if;
  return public.set_member_status_internal(p_actor_id,p_org_id,p_user_id,p_status,p_role);
end $$;
revoke all on function public.set_member_status(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.set_member_status(uuid,uuid,uuid,text,text) to service_role;

create function public.user_needs_password(p_user_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce(encrypted_password,'')='' from auth.users where id=p_user_id
$$;
revoke all on function public.user_needs_password(uuid) from public,anon,authenticated;
grant execute on function public.user_needs_password(uuid) to service_role;

create function public.export_ledger_data(p_actor_id uuid,p_org uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t text; rows jsonb; result jsonb:='{}';
begin
  if not public.is_super_admin(p_actor_id) then raise exception 'Forbidden' using errcode='42501'; end if;
  for t in select unnest(array['business_profiles','categories','transactions','credit_sales','credit_payments','budgets','budget_items','budget_retirements','audit_events','stock_items','stock_movements','commission_roles','workers','dispatches','vendor_remittances','commission_payments']) loop
    execute format('select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)->>''id''),''[]''::jsonb) from public.%I r where organization_id=$1',t) into rows using p_org;
    result:=result||jsonb_build_object(t,rows);
  end loop;
  return result;
end $$;
revoke all on function public.export_ledger_data(uuid,uuid) from public,anon,authenticated;
grant execute on function public.export_ledger_data(uuid,uuid) to service_role;
