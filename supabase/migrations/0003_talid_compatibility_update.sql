-- TALID migration 0003 (revised)
-- Compatibility and admin access for the EXISTING TALID schema.
-- Additive only: does not drop tables, columns, or rows.
-- Review before execution. Run once in Supabase SQL Editor.

begin;

create extension if not exists pgcrypto;

-- 1) Market compatibility fields used by TALID control/UI.
alter table public.talid_markets
  add column if not exists code text,
  add column if not exists name_ar text,
  add column if not exists currency text;

update public.talid_markets
set code = coalesce(code, country_code),
    name_ar = coalesce(name_ar, country_name),
    currency = coalesce(
      currency,
      case upper(country_code)
        when 'EG' then 'EGP'
        when 'SA' then 'SAR'
        when 'AE' then 'AED'
        when 'OM' then 'OMR'
        when 'IQ' then 'IQD'
        else 'XXX'
      end
    )
where code is null or name_ar is null or currency is null;

create unique index if not exists talid_markets_code_uidx
  on public.talid_markets(code)
  where code is not null;

-- Seed target markets as disabled/unverified. Existing rows are preserved.
insert into public.talid_markets
  (country_code, country_name, code, name_ar, currency, is_enabled, provider_verified)
values
  ('EG','مصر','EG','مصر','EGP',false,false),
  ('SA','السعودية','SA','السعودية','SAR',false,false),
  ('AE','الإمارات','AE','الإمارات','AED',false,false),
  ('OM','عُمان','OM','عُمان','OMR',false,false),
  ('IQ','العراق','IQ','العراق','IQD',false,false)
on conflict (country_code) do nothing;

-- 2) Extend the existing webhook inbox without replacing its schema.
alter table public.talid_webhook_events
  add column if not exists event_id text,
  add column if not exists signature_valid boolean not null default false,
  add column if not exists processed boolean not null default false,
  add column if not exists error text;

update public.talid_webhook_events
set event_id = coalesce(event_id, event_key),
    processed = (processing_status = 'processed'),
    error = coalesce(error, last_error)
where event_id is null
   or processed is distinct from (processing_status = 'processed')
   or (error is null and last_error is not null);

-- 3) Extend the existing jobs queue for worker scheduling/retries.
alter table public.talid_jobs
  add column if not exists payload jsonb not null default '{}'::jsonb,
  add column if not exists attempts integer not null default 0,
  add column if not exists run_after timestamptz not null default now(),
  add column if not exists last_error text,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists talid_jobs_queue_idx
  on public.talid_jobs(status, run_after, created_at);

-- 4) Reusable owner/admin check.
-- SECURITY DEFINER lets this helper check profiles without triggering
-- profiles-table RLS recursion. It only returns true for active owner/admin.
create or replace function public.talid_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.is_active = true
      and p.role::text in ('owner', 'admin')
  );
$function$;

revoke all on function public.talid_is_admin() from public;
grant execute on function public.talid_is_admin() to authenticated;

-- 5) Admin access to existing business and TALID control tables.
-- Do NOT create parallel talid_products/talid_orders/talid_campaigns tables:
-- the project already uses products/orders/marketing_campaigns.
do $block$
declare
  t text;
  tables_to_secure text[] := array[
    'products',
    'product_country_prices',
    'orders',
    'order_items',
    'customers',
    'marketing_campaigns',
    'talid_markets',
    'talid_integrations',
    'talid_runtime',
    'talid_audit_logs',
    'talid_webhook_events',
    'talid_jobs'
  ];
begin
  foreach t in array tables_to_secure loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists %I on public.%I', t || '_admin_all', t);
      execute format(
        'create policy %I on public.%I for all to authenticated using (public.talid_is_admin()) with check (public.talid_is_admin())',
        t || '_admin_all', t
      );
      execute format('revoke all on public.%I from anon', t);
      execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    end if;
  end loop;
end
$block$;

-- Preserve the existing public read policies on active catalog data.
-- Add admin write/read access to categories and countries without removing
-- their current public SELECT policies.
do $block$
declare
  t text;
begin
  foreach t in array array['categories', 'countries'] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists %I on public.%I', t || '_admin_all', t);
      execute format(
        'create policy %I on public.%I for all to authenticated using (public.talid_is_admin()) with check (public.talid_is_admin())',
        t || '_admin_all', t
      );
      execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    end if;
  end loop;
end
$block$;

-- Grant sequence access only for identity-backed TALID log tables if present.
do $block$
begin
  if to_regclass('public.talid_audit_logs_id_seq') is not null then
    grant usage, select on sequence public.talid_audit_logs_id_seq to authenticated;
  end if;
  if to_regclass('public.talid_integrations_id_seq') is not null then
    grant usage, select on sequence public.talid_integrations_id_seq to authenticated;
  end if;
  if to_regclass('public.talid_jobs_id_seq') is not null then
    grant usage, select on sequence public.talid_jobs_id_seq to authenticated;
  end if;
  if to_regclass('public.talid_markets_id_seq') is not null then
    grant usage, select on sequence public.talid_markets_id_seq to authenticated;
  end if;
end
$block$;

commit;
