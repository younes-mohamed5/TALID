import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EASYORDERS_API_KEY = Deno.env.get("EASYORDERS_API_KEY");

const ALLOWED_ORIGINS = new Set([
  "https://younes-mohamed5.github.io",
]);

function corsHeaders(origin: string | null) {
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://younes-mohamed5.github.io";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function asText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function extractProducts(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const candidates: unknown[] = [
    root.data, root.products, root.result, root.items,
    (root.data as Record<string, unknown> | undefined)?.products,
    (root.data as Record<string, unknown> | undefined)?.items,
    (root.result as Record<string, unknown> | undefined)?.data,
    (root.result as Record<string, unknown> | undefined)?.products,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
    }
  }
  return [];
}


async function readEasyOrdersProduct(productId: string): Promise<Record<string, unknown>> {
  const url = new URL("https://api.easy-orders.net/api/v1/external-apps/products/" + encodeURIComponent(productId));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { "Api-Key": EASYORDERS_API_KEY!, "Accept": "application/json" },
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error("EasyOrders product detail request failed (" + response.status + ").");
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { throw new Error("EasyOrders returned a non-JSON product detail response."); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Unexpected EasyOrders product detail format.");
    const root = payload as Record<string, unknown>;
    const nested = root.data && typeof root.data === "object" && !Array.isArray(root.data)
      ? root.data as Record<string, unknown> : root;
    return nested;
  } finally { clearTimeout(timeout); }
}

function extractMeta(payload: unknown) {
  if (!payload || typeof payload !== "object") return {};
  const root = payload as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : {};
  const meta = root.meta && typeof root.meta === "object" ? root.meta as Record<string, unknown> : {};
  const pagination = root.pagination && typeof root.pagination === "object"
    ? root.pagination as Record<string, unknown>
    : (data.pagination && typeof data.pagination === "object" ? data.pagination as Record<string, unknown> : {});
  return {
    total: root.total ?? meta.total ?? pagination.total ?? data.total ?? null,
    current_page: root.current_page ?? meta.current_page ?? pagination.current_page ?? data.current_page ?? null,
    last_page: root.last_page ?? meta.last_page ?? pagination.last_page ?? data.last_page ?? null,
    per_page: root.per_page ?? meta.per_page ?? pagination.per_page ?? data.per_page ?? null,
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "POST required" }, 405, origin);

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ error: "Supabase function environment is incomplete." }, 503, origin);
  }

  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return json({ error: "A signed-in TALID user session is required." }, 401, origin);
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: userData, error: authError } = await userClient.auth.getUser();
  const user = userData?.user;
  if (authError || !user) return json({ error: "The TALID session is invalid or expired. Sign in again." }, 401, origin);

  const adminClient = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("role,is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) return json({ error: "Could not verify the TALID account role.", details: profileError.message }, 500, origin);
  if (!profile?.is_active || !["owner", "admin"].includes(String(profile.role || "").toLowerCase())) {
    return json({ error: "Only an active TALID owner or admin can preview the EasyOrders catalog." }, 403, origin);
  }

  if (!EASYORDERS_API_KEY) {
    return json({ error: "EASYORDERS_API_KEY is missing from Supabase Edge Function secrets." }, 503, origin);
  }

  let requestBody: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object") requestBody = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400, origin);
  }

  const marketCurrencies: Record<string, string> = { EG: "EGP", SA: "SAR", AE: "AED", OM: "OMR", IQ: "IQD" };

  if (requestBody.mode === "get_store_config") {
    const { data, error } = await adminClient.from("integration_connections").select("display_name,config_public").eq("provider", "easyorders").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) return json({ error: error.message }, 500, origin);
    const config = (data?.config_public || {}) as Record<string, unknown>;
    return json({ success: true, store: { country_code: asText(config.country_code), currency_code: asText(config.currency_code), store_url: asText(config.store_url), display_name: data?.display_name || "EasyOrders" } }, 200, origin);
  }

  if (requestBody.mode === "configure_store") {
    const countryCode = String(requestBody.country_code || "").trim().toUpperCase();
    const currencyCode = marketCurrencies[countryCode];
    if (!currencyCode) return json({ error: "اختر دولة مدعومة." }, 400, origin);
    const storeUrl = asText(requestBody.store_url);
    if (storeUrl) { try { if (new URL(storeUrl).protocol !== "https:") throw new Error(); } catch { return json({ error: "رابط المتجر يجب أن يبدأ بـ https://." }, 400, origin); } }
    const { data: country, error: countryError } = await adminClient.from("countries").select("id").eq("code", countryCode).maybeSingle();
    if (countryError || !country) return json({ error: "الدولة المختارة غير موجودة في جدول الدول." }, 400, origin);
    const { data: existing, error: findError } = await adminClient.from("integration_connections").select("id,config_public").eq("provider", "easyorders").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (findError) return json({ error: findError.message }, 500, origin);
    const config = { ...((existing?.config_public || {}) as Record<string, unknown>), country_code: countryCode, currency_code: currencyCode, store_url: storeUrl, country_confirmed_at: new Date().toISOString() };
    const result = existing ? await adminClient.from("integration_connections").update({ config_public: config, display_name: "EasyOrders - " + countryCode }).eq("id", existing.id) : await adminClient.from("integration_connections").insert({ provider: "easyorders", display_name: "EasyOrders - " + countryCode, status: "pending_verification", config_public: config });
    if (result.error) return json({ error: result.error.message }, 500, origin);
    return json({ success: true, country_code: countryCode, currency_code: currencyCode, store_url: storeUrl }, 200, origin);
  }

  // Import is insert-only: known EasyOrders IDs/SKUs are skipped, never overwritten.
  // EasyOrders listed price is stored as supplier cost; TALID sale price is set only after pricing approval.
  if (requestBody.mode === "import") {
    const limit = Math.max(1, Math.min(50, Math.floor(Number(requestBody.limit ?? 50) || 50)));
    const page = Math.max(1, Math.floor(Number(requestBody.page ?? 1) || 1));
    const { data: connection, error: connectionError } = await adminClient.from("integration_connections")
      .select("config_public").eq("provider", "easyorders").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (connectionError) return json({ error: connectionError.message }, 500, origin);
    const storeConfig = (connection?.config_public || {}) as Record<string, unknown>;
    const countryCode = asText(storeConfig.country_code)?.toUpperCase();
    const currency = countryCode ? ({ EG:"EGP", SA:"SAR", AE:"AED", OM:"OMR", IQ:"IQD" } as Record<string,string>)[countryCode] : null;
    if (!countryCode || !currency) return json({ error: "حدد دولة متجر EasyOrders من صفحة التكاملات أولاً.", setup_required: true }, 409, origin);
    const { data: country, error: countryError } = await adminClient.from("countries").select("id").eq("code", countryCode).maybeSingle();
    if (countryError || !country) return json({ error: "الدولة المختارة غير موجودة في جدول الدول." }, 400, origin);
    const endpoint = new URL("https://api.easy-orders.net/api/v1/external-apps/products");
    endpoint.searchParams.set("page", String(page)); endpoint.searchParams.set("limit", String(limit));
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const upstream = await fetch(endpoint.toString(), { method:"GET", headers:{ "Api-Key": EASYORDERS_API_KEY!, "Accept":"application/json" }, signal:controller.signal });
      const raw = await upstream.text();
      if (!upstream.ok) return json({ success:false, error:"EasyOrders rejected the catalog import.", upstream_status:upstream.status }, 502, origin);
      let payload: unknown; try { payload = JSON.parse(raw); } catch { return json({ success:false, error:"EasyOrders returned a non-JSON catalog response." }, 502, origin); }
      const sourceProducts = extractProducts(payload);
      const prepared = sourceProducts.map((source) => {
        const id = asText(source.id); const name = asText(source.name_ar) || asText(source.name) || asText(source.title);
        const supplierSku = asText(source.sku) || asText(source.taager_code);
        const sku = supplierSku || (id ? "EO-" + id : null);
        const rawCost = source.sale_price ?? source.price; const cost = rawCost == null || rawCost === "" ? null : Number(rawCost);
        const images = [...new Set([...(asText(source.thumb) ? [asText(source.thumb)!] : []), ...(Array.isArray(source.images) ? source.images.map(asText).filter((v): v is string => !!v) : [])])];
        const qtyRaw = source.quantity; const qty = qtyRaw == null || qtyRaw === "" ? null : Number(qtyRaw);
        const slugBase = (asText(source.slug) || name || "easyorders-product").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,60) || "easyorders-product";
        return { id, name, supplierSku, sku, cost: cost != null && Number.isFinite(cost) ? cost : null, images, qty: qty != null && Number.isFinite(qty) ? Math.max(0,Math.floor(qty)) : null, slug: slugBase + "-" + (id || crypto.randomUUID()).replace(/[^a-zA-Z0-9-]/g,"").slice(0,24), source };
      }).filter((p) => p.id && p.name && p.sku);
      const uniquePrepared = [...new Map(prepared.map((p) => [String(p.id), p])).values()];
      const ids = [...new Set(uniquePrepared.map((p) => p.id!))];
      const skus = [...new Set(uniquePrepared.map((p) => p.sku!))];
      const supplierSkus = [...new Set(uniquePrepared.map((p) => p.supplierSku).filter((v): v is string => !!v))];
      const knownIds = new Set<string>(); const knownSkus = new Set<string>();
      if (ids.length) { const q = await adminClient.from("products").select("supplier_product_id").in("supplier_product_id",ids); if(q.error) throw new Error(q.error.message); for(const row of q.data||[]) if(row.supplier_product_id) knownIds.add(String(row.supplier_product_id)); }
      if (skus.length) { const q = await adminClient.from("products").select("sku").in("sku",skus); if(q.error) throw new Error(q.error.message); for(const row of q.data||[]) if(row.sku) knownSkus.add(String(row.sku)); }
      if (supplierSkus.length) { const q = await adminClient.from("products").select("supplier_sku").in("supplier_sku",supplierSkus); if(q.error) throw new Error(q.error.message); for(const row of q.data||[]) if(row.supplier_sku) knownSkus.add(String(row.supplier_sku)); }
      const newProducts = uniquePrepared.filter((p) => !knownIds.has(p.id!) && !knownSkus.has(p.sku!) && !(p.supplierSku && knownSkus.has(p.supplierSku)));
      let imported = 0; let skipped = prepared.length - newProducts.length;
      for (const p of newProducts) {
        const insert = await adminClient.from("products").insert({ sku:p.sku, name_ar:p.name, slug:p.slug, description:asText(p.source.description), supplier_name:"EasyOrders", supplier_product_id:p.id, supplier_sku:p.supplierSku, cost_price:p.cost, sale_price:null, currency_code:currency, stock_qty:p.qty, stock_status:p.qty == null ? "unknown" : p.qty > 0 ? "in_stock" : "out_of_stock", images:p.images, status:"draft", attributes:{ source:"easyorders", country_code:countryCode, taager_code:asText(p.source.taager_code) } }).select("id,cost_price").single();
        if (insert.error) { if (insert.error.code === "23505") { skipped++; continue; } throw new Error(insert.error.message); }
        const price = await adminClient.from("product_country_prices").upsert({ product_id:insert.data.id, country_id:country.id, cost_price:insert.data.cost_price, sale_price:null, shipping_cost:null, currency_code:currency, is_available:false }, { onConflict:"product_id,country_id" });
        if (price.error) throw new Error("Product saved but country price record failed: " + price.error.message);
        imported++;
      }
      await adminClient.from("sync_logs").insert({ provider:"easyorders", entity_type:"products", direction:"inbound", status:"success", records_count:imported, message:"New EasyOrders products imported; duplicates skipped; source price saved as cost only.", details:{ page, limit, country_code:countryCode, currency_code:currency, fetched:sourceProducts.length, imported, skipped } });
      return json({ success:true, mode:"import", page, country_code:countryCode, currency_code:currency, fetched:sourceProducts.length, imported, skipped, database_changed:imported>0, note:"Existing products were skipped. EasyOrders price is saved as supplier cost; TALID sale price remains empty until market pricing approval." }, 200, origin);
    } catch(error) { const timedOut = error instanceof DOMException && error.name === "AbortError"; return json({ success:false, error:timedOut ? "EasyOrders catalog import timed out." : (error instanceof Error ? error.message : "Import failed.") }, 502, origin); }
    finally { clearTimeout(timeout); }
  }
  // Preview and authenticated single-product detail reads are read-only.
  if (requestBody.mode === "detail") {
    const productId = asText(requestBody.product_id);
    if (!productId) return json({ error: "product_id is required for detail mode." }, 400, origin);
    try {
      const product = await readEasyOrdersProduct(productId);
      const imageList = Array.isArray(product.images) ? product.images.map(asText).filter(Boolean) : [];
      const thumb = asText(product.thumb);
      return json({
        success: true,
        mode: "detail",
        product: {
          id: asText(product.id) || productId,
          name: asText(product.name) || asText(product.name_ar) || asText(product.title) || "بدون اسم",
          description: asText(product.description),
          slug: asText(product.slug),
          sku: asText(product.sku),
          taager_code: asText(product.taager_code),
          price: product.sale_price ?? product.price ?? null,
          original_price: product.price ?? null,
          quantity: product.quantity ?? null,
          currency: asText(product.currency_code) || asText(product.currency) || null,
          image: thumb || imageList[0] || null,
          images: [...new Set([...(thumb ? [thumb] : []), ...imageList])],
          categories: Array.isArray(product.categories) ? product.categories : [],
          variations: Array.isArray(product.variations) ? product.variations : [],
          variants: Array.isArray(product.variants) ? product.variants : [],
          raw_fields: Object.keys(product),
        },
        database_changed: false,
      }, 200, origin);
    } catch (error) {
      return json({ success: false, error: error instanceof Error ? error.message : "Could not read product details." }, 502, origin);
    }
  }

  if (requestBody.mode && requestBody.mode !== "preview") {
    return json({ error: "Unsupported mode. Only preview and detail reads are enabled.", mode: "read_only" }, 409, origin);
  }

  const requestedLimit = Number(requestBody.limit ?? 30);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.floor(requestedLimit))) : 30;
  const page = 1;
  const endpoint = new URL("https://api.easy-orders.net/api/v1/external-apps/products");
  endpoint.searchParams.set("page", String(page));
  endpoint.searchParams.set("limit", String(limit));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const upstream = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        "Api-Key": EASYORDERS_API_KEY,
        "Accept": "application/json",
      },
      signal: controller.signal,
    });

    const raw = await upstream.text();
    if (!upstream.ok) {
      return json({
        success: false,
        error: "EasyOrders rejected the catalog request.",
        upstream_status: upstream.status,
        explanation: upstream.status === 401 || upstream.status === 403
          ? "Check the API key and its products:read permission in EasyOrders."
          : "Check the EasyOrders API response and try again.",
        // Do not return upstream body: it may contain sensitive provider diagnostics.
      }, 502, origin);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json({ success: false, error: "EasyOrders returned a non-JSON response." }, 502, origin);
    }

    const products = extractProducts(payload);
    const meta = extractMeta(payload);
    const preview = products.slice(0, limit).map((product) => ({
      id: asText(product.id),
      name: asText(product.name) || asText(product.name_ar) || asText(product.title) || "بدون اسم",
      sku: asText(product.sku),
      taager_code: asText(product.taager_code),
      price: product.sale_price ?? product.price ?? null,
      quantity: product.quantity ?? null,
      image: asText(product.thumb) || (Array.isArray(product.images) ? asText(product.images[0]) : null),
      images: Array.isArray(product.images) ? product.images.map(asText).filter(Boolean) : [],
      description: asText(product.description),
      slug: asText(product.slug),
      original_price: product.price ?? null,
      currency: asText(product.currency_code) || asText(product.currency) || null,
    }));

    return json({
      success: true,
      mode: "preview",
      fetched: products.length,
      page,
      limit,
      pagination: meta,
      preview,
      database_changed: false,
      message: products.length
        ? "EasyOrders catalog read succeeded. Preview only; no TALID data was changed."
        : "EasyOrders responded successfully, but no product array was found. Review the response format with EasyOrders support.",
      response_keys: payload && typeof payload === "object" && !Array.isArray(payload)
        ? Object.keys(payload as Record<string, unknown>)
        : [],
    }, 200, origin);
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    return json({
      success: false,
      error: timedOut ? "EasyOrders request timed out after 20 seconds." : "Could not complete the EasyOrders catalog request.",
      details: timedOut ? undefined : (error instanceof Error ? error.message : String(error)),
    }, 502, origin);
  } finally {
    clearTimeout(timeout);
  }
});
