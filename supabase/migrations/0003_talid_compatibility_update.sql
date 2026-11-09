-- TALID release v1 compatibility migration
-- Additive migration for the EXISTING TALID database. Does not drop tables or rows.
begin;
create extension if not exists pgcrypto;

-- Align the existing markets table with the web application while preserving
-- its original country_code/country_name columns and current constraints.
alter table public.talid_markets
  add column if not exists code text,
  add column if not exists name_ar text,
  add column if not exists currency text;

update public.talid_markets
set code = coalesce(code, country_code),
    name_ar = coalesce(name_ar, country_name),
    currency = coalesce(currency, case upper(country_code)
      when 'EG' then 'EGP' when 'SA' then 'SAR' when 'AE' then 'AED'
      when 'OM' then 'OMR' when 'IQ' then 'IQD' else 'XXX' end)
where code is null or name_ar is null or currency is null;

create unique index if not exists talid_markets_code_uidx
  on public.talid_markets(code) where code is not null;

-- Seed the five target markets disabled and unverified. Existing rows are preserved.
insert into public.talid_markets
  (country_code, country_name, code, name_ar, currency, is_enabled, provider_verified)
values
  ('EG','مصر','EG','مصر','EGP',false,false),
  ('SA','السعودية','SA','السعودية','SAR',false,false),
  ('AE','الإمارات','AE','الإمارات','AED',false,false),
  ('OM','عُمان','OM','عُمان','OMR',false,false),
  ('IQ','العراق','IQ','العراق','IQD',false,false)
on conflict (country_code) do nothing;

create table if not exists public.talid_products (
  id uuid primary key default gen_random_uuid(),
  market_code text,
  provider text not null default 'taager',
  taager_product_code text,
  easyorders_product_id text,
  name text not null,
  description text,
  currency text not null default 'EGP',
  sale_price numeric(14,2) not null default 0,
  product_cost numeric(14,2) not null default 0,
  status text not null default 'draft',
  provider_payload jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists talid_products_provider_code_market_uidx
  on public.talid_products(provider, taager_product_code, market_code)
  where taager_product_code is not null;
create index if not exists talid_products_market_status_idx
  on public.talid_products(market_code,status);

create table if not exists public.talid_orders (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'easyorders',
  external_order_id text not null,
  market_code text,
  customer_name text,
  customer_phone text,
  status text not null default 'pending',
  amount numeric(14,2) not null default 0,
  currency text not null default 'EGP',
  product_cost numeric(14,2) not null default 0,
  shipping_cost numeric(14,2) not null default 0,
  ad_cost numeric(14,2) not null default 0,
  other_cost numeric(14,2) not null default 0,
  delivered_at timestamptz,
  source_updated_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint talid_orders_source_external_uidx unique(source,external_order_id)
);
create index if not exists talid_orders_status_created_idx
  on public.talid_orders(status,created_at desc);
create index if not exists talid_orders_market_idx
  on public.talid_orders(market_code,created_at desc);

create table if not exists public.talid_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  market_code text,
  status text not null default 'draft',
  proposed_budget numeric(14,2) not null default 0,
  currency text not null default 'EGP',
  external_campaign_id text,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

-- Preserve the existing webhook inbox schema and add only compatibility fields.
alter table public.talid_webhook_events
  add column if not exists event_id text,
  add column if not exists signature_valid boolean not null default false,
  add column if not exists processed boolean not null default false,
  add column if not exists error text;

update public.talid_webhook_events
set event_id = coalesce(event_id,event_key),
    processed = (processing_status = 'processed'),
    error = coalesce(error,last_error)
where event_id is null or processed is distinct from (processing_status = 'processed');

-- Preserve bigint identity IDs and existing pending jobs; add worker metadata.
alter table public.talid_jobs
  add column if not exists payload jsonb not null default '{}'::jsonb,
  add column if not exists attempts integer not null default 0,
  add column if not exists run_after timestamptz not null default now(),
  add column if not exists last_error text,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists talid_jobs_queue_idx
  on public.talid_jobs(status,run_after,created_at);

-- Owner/admin policy helper.
create or replace function public.talid_is_admin()
returns boolean language sql stable security definer set search_path=public as $$
  select exists (
    select 1 from public.profiles p
    where p.id=auth.uid() and p.is_active=true and p.role::text in ('owner','admin')
  );
$$;
revoke all on function public.talid_is_admin() from public;
grant execute on function public.talid_is_admin() to authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'talid_markets','talid_products','talid_orders','talid_campaigns',
    'talid_integrations','talid_runtime','talid_audit_logs',
    'talid_webhook_events','talid_jobs'
  ] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('drop policy if exists %I on public.%I',t||'_admin_all',t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.talid_is_admin()) with check (public.talid_is_admin())',
      t||'_admin_all',t
    );
    execute format('revoke all on public.%I from anon',t);
    execute format('grant select,insert,update,delete on public.%I to authenticated',t);
  end loop;
end $$;

do $$
begin
  if to_regclass('public.talid_audit_logs_id_seq') is not null then
    grant usage,select on sequence public.talid_audit_logs_id_seq to authenticated;
  end if;
end $$;

commit;
