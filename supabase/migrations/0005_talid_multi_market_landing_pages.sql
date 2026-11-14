-- TALID multi-market catalogs and landing-page builder
begin;
update public.countries set is_enabled = true where code in ('EG','SA','AE','OM','IQ');
update public.talid_markets set is_enabled = true where upper(coalesce(code,country_code)) in ('EG','SA','AE','OM','IQ');
create index if not exists product_country_prices_country_product_idx on public.product_country_prices(country_id, product_id);

create table if not exists public.product_landing_pages (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  country_id uuid not null references public.countries(id) on delete cascade,
  slug text not null unique,
  headline text not null,
  subheadline text,
  body text,
  benefits jsonb not null default '[]'::jsonb,
  images jsonb not null default '[]'::jsonb,
  sale_price numeric(12,2),
  currency_code text not null,
  seo_title text,
  seo_description text,
  competitor_analysis jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft','ready_for_review','published','archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  unique(product_id,country_id)
);
create index if not exists product_landing_pages_country_status_idx on public.product_landing_pages(country_id,status,updated_at desc);
alter table public.product_landing_pages enable row level security;
drop policy if exists product_landing_pages_admin_all on public.product_landing_pages;
create policy product_landing_pages_admin_all on public.product_landing_pages for all to authenticated using (public.talid_is_admin()) with check (public.talid_is_admin());
drop policy if exists product_landing_pages_public_published on public.product_landing_pages;
create policy product_landing_pages_public_published on public.product_landing_pages for select to anon, authenticated using (status = 'published');
grant select, insert, update, delete on public.product_landing_pages to authenticated;
grant select on public.product_landing_pages to anon;
commit;
