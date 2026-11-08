-- TALID foundation schema for Supabase/PostgreSQL
create extension if not exists pgcrypto;

create table if not exists public.countries (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text not null,
  currency_code text not null,
  currency_symbol text not null,
  is_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.countries(code,name_ar,name_en,currency_code,currency_symbol,is_enabled) values
('EG','مصر','Egypt','EGP','ج.م',true),
('SA','السعودية','Saudi Arabia','SAR','ر.س',false),
('AE','الإمارات','United Arab Emirates','AED','د.إ',false),
('OM','عُمان','Oman','OMR','ر.ع',false),
('IQ','العراق','Iraq','IQD','د.ع',false)
on conflict(code) do nothing;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'staff' check (role in ('owner','admin','manager','support','marketing','viewer')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null,
  slug text not null unique,
  description text,
  image_url text,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  sku text unique,
  name_ar text not null,
  name_en text,
  slug text not null unique,
  description text,
  category_id uuid references public.categories(id) on delete set null,
  supplier_name text,
  supplier_product_id text,
  supplier_sku text,
  cost_price numeric(12,2),
  sale_price numeric(12,2),
  currency_code text not null default 'EGP',
  stock_qty int,
  stock_status text not null default 'unknown' check (stock_status in ('in_stock','out_of_stock','preorder','unknown')),
  status text not null default 'draft' check (status in ('draft','active','paused','archived')),
  images jsonb not null default '[]'::jsonb,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_country_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  country_id uuid not null references public.countries(id) on delete cascade,
  sale_price numeric(12,2),
  cost_price numeric(12,2),
  shipping_cost numeric(12,2),
  currency_code text not null,
  is_available boolean not null default false,
  unique(product_id,country_id)
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  full_name text,
  phone text,
  email text,
  country_id uuid references public.countries(id),
  city text,
  address text,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists customers_phone_idx on public.customers(phone);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id uuid references public.customers(id),
  country_id uuid references public.countries(id),
  source_channel text not null default 'store',
  external_order_id text,
  status text not null default 'pending' check (status in ('pending','confirmed','processing','shipped','delivered','cancelled','returned','failed')),
  currency_code text not null default 'EGP',
  subtotal numeric(12,2) not null default 0,
  shipping_amount numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  supplier_cost numeric(12,2) not null default 0,
  ad_cost numeric(12,2) not null default 0,
  other_cost numeric(12,2) not null default 0,
  tracking_number text,
  shipping_provider text,
  customer_notes text,
  internal_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_status_created_idx on public.orders(status,created_at desc);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  sku text,
  quantity int not null check (quantity > 0),
  unit_price numeric(12,2) not null,
  unit_cost numeric(12,2) not null default 0,
  line_total numeric(12,2) generated always as (quantity * unit_price) stored
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  channel text not null check (channel in ('whatsapp','messenger','instagram','store','other')),
  external_conversation_id text,
  status text not null default 'open' check (status in ('open','waiting','resolved','human_handoff')),
  assigned_to uuid references public.profiles(id),
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  external_message_id text,
  direction text not null check (direction in ('inbound','outbound')),
  sender_type text not null check (sender_type in ('customer','agent','ai','system')),
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.ai_knowledge_base (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  category text,
  is_published boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('easyorders','taager','shipping','meta','whatsapp','other')),
  display_name text not null,
  status text not null default 'not_configured' check (status in ('not_configured','pending_verification','connected','error','disabled')),
  config_public jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table if not exists public.sync_logs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  entity_type text not null,
  direction text not null check (direction in ('inbound','outbound')),
  status text not null check (status in ('started','success','failed','skipped')),
  records_count int not null default 0,
  message text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  platform text not null,
  country_id uuid references public.countries(id),
  status text not null default 'draft' check (status in ('draft','pending_approval','approved','active','paused','completed')),
  budget numeric(12,2),
  currency_code text,
  start_at timestamptz,
  end_at timestamptz,
  content jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Enable RLS. Production policies must be tightened after the owner/admin user is created.
alter table public.countries enable row level security;
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_country_prices enable row level security;
alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.ai_knowledge_base enable row level security;
alter table public.integration_connections enable row level security;
alter table public.sync_logs enable row level security;
alter table public.marketing_campaigns enable row level security;
alter table public.audit_logs enable row level security;

-- Public storefront read policies: only active catalog records are exposed.
drop policy if exists "public read enabled countries" on public.countries;
create policy "public read enabled countries" on public.countries for select using (is_enabled = true);
drop policy if exists "public read active categories" on public.categories;
create policy "public read active categories" on public.categories for select using (is_active = true);
drop policy if exists "public read active products" on public.products;
create policy "public read active products" on public.products for select using (status = 'active');
drop policy if exists "public read available country prices" on public.product_country_prices;
create policy "public read available country prices" on public.product_country_prices for select using (is_available = true);

-- No public write policies are intentionally created for orders, customers, integrations, or admin data.
-- Add authenticated role policies before production deployment.
