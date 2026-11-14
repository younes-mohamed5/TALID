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

  // Import mode writes EasyOrders catalog records into the existing products table.
  // New products remain draft; existing product status and manually entered cost_price are preserved.
  if (requestBody.mode === "import") {
    const requestedLimit = Number(requestBody.limit ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.floor(requestedLimit))) : 50;
    const requestedPage = Number(requestBody.page ?? 1);
    const page = Number.isFinite(requestedPage) ? Math.max(1, Math.min(10000, Math.floor(requestedPage))) : 1;
    const endpoint = new URL("https://api.easy-orders.net/api/v1/external-apps/products");
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("limit", String(limit));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const upstream = await fetch(endpoint.toString(), {
        method: "GET",
        headers: { "Api-Key": EASYORDERS_API_KEY, "Accept": "application/json" },
        signal: controller.signal,
      });
      const raw = await upstream.text();
      if (!upstream.ok) {
        return json({ success: false, error: "EasyOrders rejected the catalog import.", upstream_status: upstream.status }, 502, origin);
      }
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch {
        return json({ success: false, error: "EasyOrders returned a non-JSON catalog response." }, 502, origin);
      }
      const sourceProducts = extractProducts(payload);
      const rows: Record<string, unknown>[] = [];
      const skipped: string[] = [];
      for (const source of sourceProducts) {
        const sourceId = asText(source.id);
        const name = asText(source.name_ar) || asText(source.name) || asText(source.title);
        if (!sourceId || !name) {
          skipped.push(sourceId || "unknown-id");
          continue;
        }
        const sourceSku = asText(source.sku) || asText(source.taager_code);
        const sku = sourceSku || ("EO-" + sourceId);
        const imageList = Array.isArray(source.images) ? source.images.map(asText).filter(Boolean) : [];
        const thumb = asText(source.thumb);
        const images = [...new Set([...(thumb ? [thumb] : []), ...imageList])];
        const rawQuantity = source.quantity;
        const quantity = rawQuantity == null || rawQuantity === "" ? null : Number(rawQuantity);
        const stockQty = quantity != null && Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : null;
        const stockStatus = stockQty == null ? "unknown" : stockQty > 0 ? "in_stock" : "out_of_stock";
        const rawPrice = source.sale_price ?? source.price;
        const salePrice = rawPrice == null || rawPrice === "" ? null : Number(rawPrice);
        const currency = asText(source.currency_code) || asText(source.currency) || "EGP";
        const slugBase = (asText(source.slug) || name)
          .toLowerCase()
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 70) || "easyorders-product";
        rows.push({
          sku,
          name_ar: name,
          name_en: asText(source.name_en),
          slug: slugBase + "-" + sourceId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 24),
          description: asText(source.description),
          supplier_name: "EasyOrders",
          supplier_product_id: sourceId,
          supplier_sku: sourceSku,
          sale_price: salePrice != null && Number.isFinite(salePrice) ? salePrice : null,
          currency_code: currency,
          stock_qty: stockQty,
          stock_status: stockStatus,
          images,
          attributes: {
            source: "easyorders",
            easyorders_slug: asText(source.slug),
            taager_code: asText(source.taager_code),
            original_price: source.price ?? null,
          },
          updated_at: new Date().toISOString(),
        });
      }
      const uniqueRows = [...new Map(rows.map((row) => [String(row.sku), row])).values()];
      let imported = 0;
      if (uniqueRows.length) {
        const { data: saved, error: saveError } = await adminClient
          .from("products")
          .upsert(uniqueRows, { onConflict: "sku" })
          .select("id");
        if (saveError) {
          return json({ success: false, error: "Could not save EasyOrders products to TALID.", details: saveError.message, fetched: sourceProducts.length, prepared: uniqueRows.length }, 500, origin);
        }
        imported = saved?.length ?? rows.length;
      }
      await adminClient.from("sync_logs").insert({
        provider: "easyorders",
        entity_type: "products",
        direction: "inbound",
        status: "success",
        records_count: imported,
        message: "EasyOrders catalog page imported into TALID products.",
        details: { page, limit, fetched: sourceProducts.length, saved: imported, skipped },
      });
      return json({
        success: true,
        mode: "import",
        page,
        fetched: sourceProducts.length,
        prepared: uniqueRows.length,
        imported,
        skipped,
        database_changed: imported > 0,
        note: "New products remain draft. Existing product status and manually entered cost_price are preserved. Supplier cost is not inferred from the retail price.",
      }, 200, origin);
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "AbortError";
      return json({ success: false, error: timedOut ? "EasyOrders catalog import timed out." : "EasyOrders catalog import failed.", details: timedOut ? undefined : (error instanceof Error ? error.message : String(error)) }, 502, origin);
    } finally {
      clearTimeout(timeout);
    }
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
