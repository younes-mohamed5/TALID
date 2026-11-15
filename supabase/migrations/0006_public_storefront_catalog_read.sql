-- Restore anonymous read access to the public storefront catalog.
-- RLS remains the row-level boundary: only active products and available prices
-- are visible through the existing public SELECT policies.
begin;

grant select on table public.products to anon, authenticated;
grant select on table public.product_country_prices to anon, authenticated;
grant select on table public.product_landing_pages to anon, authenticated;
grant select on table public.countries to anon, authenticated;

commit;
