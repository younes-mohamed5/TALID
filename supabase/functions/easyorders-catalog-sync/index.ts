import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EASYORDERS_API_KEY = Deno.env.get("EASYORDERS_API_KEY");

const cors = {
  "Access-Control-Allow-Origin": "https://younes-mohamed5.github.io",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

function slugify(value: string): string {
  const slug = value.toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 55);
  return slug || "easyorders-product";
}

function extractProducts(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "products", "result", "items"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.[key]?.data)) return payload[key].data;
    if (Array.isArray(payload?.[key]?.products)) return payload[key].products;
  }
  return [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) return json({ error: "Supabase environment is incomplete" }, 503);

  const authorization = req.headers.get("Authorization") || "";
  if (!authorization) return json({ error: "Authentication required" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return json({ error: "Unauthorized" }, 401);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: profile, error: profileError } = await db
    .from("profiles").select("role,is_active").eq("id", user.id).maybeSingle();
  if (profileError) return json({ error: "Could not verify permissions" }, 500);
  if (!profile?.is_active || !["owner", "admin"].includes(String(profile.role || "").toLowerCase())) {
    return json({ error: "Forbidden" }, 403);
  }

  if (!EASYORDERS_API_KEY) {
    return json({
      error: "EASYORDERS_API_KEY is not configured",
      required_secret: "EASYORDERS_API_KEY",
      instruction: "Add the EasyOrders API key in Supabase Edge Function secrets. Never send it in chat.",
    }, 503);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const mode = body?.mode === "sync" ? "sync" : "preview";
  // Import is locked until the owner reviews the preview and approves a separate sync step.
  if (mode === "sync") {
    return json({ error: "Product import is disabled. Run preview first; database changes require a separate owner-approved step.", mode: "preview_only" }, 409);
  }

  try {
    const response = await fetch("https://api.easy-orders.net/api/v1/external-apps/products", {
      method: "GET",
      headers: { "Api-Key": EASYORDERS_API_KEY, "Accept": "application/json" },
    });
    const raw = await response.text();
    if (!response.ok) {
      return json({
        error: "EasyOrders API request failed",
        upstream_status: response.status,
        details: raw.slice(0, 1200),
      }, response.status === 401 || response.status === 403 ? 502 : 502);
    }

    let payload: any;
    try { payload = JSON.parse(raw); } catch {
      return json({ error: "EasyOrders returned invalid JSON", sample: raw.slice(0, 500) }, 502);
    }

    const sourceProducts = extractProducts(payload);
    if (!sourceProducts.length) {
      return json({
        success: true, mode, fetched: 0, inserted: 0, updated: 0,
        message: "API connection responded, but no product array was recognized. No database changes were made.",
        response_keys: payload && typeof payload === "object" ? Object.keys(payload) : [],
      });
    }

    const preview = sourceProducts.slice(0, 1000).map((p: any) => ({
      id: text(p.id),
      name: text(p.name) || text(p.name_ar) || text(p.title),
      sku: text(p.sku),
      taager_code: text(p.taager_code),
      price: p.sale_price ?? p.price ?? null,
      quantity: p.quantity ?? p.stock ?? null,
      image: text(p.thumb) || (Array.isArray(p.images) ? text(p.images[0]) : null),
    }));

    if (mode === "preview") {
      return json({
        success: true, mode, fetched: sourceProducts.length,
        preview: preview.slice(0, 30),
        message: "Preview only. No products were inserted or changed.",
      });
    }

    let inserted = 0, updated = 0, skipped = 0;
    const errors: Array<{ key: string; error: string }> = [];

    for (const p of sourceProducts.slice(0, 1000)) {
      const externalId = text(p.id);
      const sku = text(p.sku) || text(p.taager_code) || externalId;
      const taagerCode = text(p.taager_code);
      const name = text(p.name_ar) || text(p.name) || text(p.title) || sku;
      if (!sku || !name) { skipped++; continue; }

      const lookupKeys = [sku, taagerCode].filter(Boolean) as string[];
      let existing: any = null;
      for (const key of lookupKeys) {
        const { data, error } = await db.from("products")
          .select("id,sku,supplier_sku,supplier_product_id,slug")
          .or(`sku.eq.${key.replace(/[(),]/g, "")},supplier_sku.eq.${key.replace(/[(),]/g, "")}`)
          .limit(1).maybeSingle();
        if (error) throw error;
        if (data) { existing = data; break; }
      }

      const images = Array.isArray(p.images)
        ? p.images.filter((v: unknown) => typeof v === "string")
        : [text(p.thumb)].filter(Boolean);
      const qty = Number(p.quantity ?? p.stock);
      const hasQty = Number.isFinite(qty);
      const patch: Record<string, unknown> = {
        name_ar: name,
        supplier_name: text(p.drop_shipping_provider) || "EasyOrders",
        supplier_product_id: externalId,
        supplier_sku: taagerCode || sku,
        images,
        attributes: { easyorders_product_id: externalId, easyorders_slug: text(p.slug), source: "easyorders" },
        updated_at: new Date().toISOString(),
      };
      if (p.description != null) patch.description = String(p.description);
      if (p.price != null && Number.isFinite(Number(p.price))) patch.sale_price = Number(p.price);
      if (hasQty) {
        patch.stock_qty = qty;
        patch.stock_status = qty > 0 ? "in_stock" : "out_of_stock";
      }
      if (!existing) {
        const baseSlug = slugify(text(p.slug) || sku);
        patch.sku = sku;
        patch.slug = `${baseSlug}-${slugify(externalId || sku).slice(-10)}`;
        patch.currency_code = text(p.currency_code) || "EGP";
        patch.status = "draft";
        const { error } = await db.from("products").insert(patch);
        if (error) errors.push({ key: sku, error: error.message });
        else inserted++;
      } else {
        const { error } = await db.from("products").update(patch).eq("id", existing.id);
        if (error) errors.push({ key: sku, error: error.message });
        else updated++;
      }
    }

    return json({
      success: errors.length === 0,
      mode, fetched: sourceProducts.length, processed: Math.min(sourceProducts.length, 1000),
      inserted, updated, skipped, errors: errors.slice(0, 20),
      note: "Imported prices are store selling prices, not supplier costs. Supplier cost remains unchanged unless independently verified.",
    });
  } catch (error) {
    return json({ error: "EasyOrders catalog sync failed", details: error instanceof Error ? error.message : String(error) }, 500);
  }
});
