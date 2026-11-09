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

  // This endpoint is deliberately preview-only. No database insert/update/delete code exists here.
  if (requestBody.mode && requestBody.mode !== "preview") {
    return json({ error: "This function is preview-only. Product import is not enabled.", mode: "preview_only" }, 409, origin);
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
      currency: asText(product.currency_code) || null,
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
