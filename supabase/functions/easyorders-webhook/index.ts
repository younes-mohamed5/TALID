
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const webhookSecret = Deno.env.get("EASYORDERS_WEBHOOK_SECRET");

if (!supabaseUrl || !serviceKey) {
  throw new Error("Missing Supabase environment");
}

const db = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const str = (v: unknown) => v == null ? "" : String(v);

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

Deno.serve(async (req) => {
  if (req.method === "GET") {
    return reply({
      service: "TALID EasyOrders webhook",
      state: "available",
    });
  }

  if (req.method !== "POST") {
    return reply({ error: "POST required" }, 405);
  }

  if (!webhookSecret) {
    return reply({ error: "Webhook secret is not configured" }, 503);
  }

  if (req.headers.get("x-talid-webhook-secret") !== webhookSecret) {
    return reply({ error: "Unauthorized" }, 401);
  }

  let payload: any;

  try {
    payload = JSON.parse(await req.text());
  } catch {
    return reply({ error: "Invalid JSON" }, 400);
  }

  const order =
    payload?.order ??
    payload?.data?.order ??
    payload?.data ??
    payload;

  const externalId = str(
    order?.id ?? order?.order_id ?? payload?.order_id
  );

  if (!externalId) {
    return reply({ error: "Order ID missing" }, 400);
  }

  const rawType = str(
    payload?.type ?? payload?.event_type ?? ""
  ).toLowerCase();

  const eventType = rawType.includes("status")
    ? "order-status-update"
    : "orders";

  const eventKey =
    str(payload?.event_id ?? payload?.id) ||
    `${eventType}:${externalId}:${str(
      order?.updated_at ?? order?.status ?? "received"
    )}`;

  const inbox = {
    provider: "easyorders",
    event_type: eventType,
    event_key: eventKey,
    event_id: eventKey,
    external_order_id: externalId,
    payload,
    signature_valid: true,
    processing_status: "received",
    processed: false,
  };

  const { error: inboxError } = await db
    .from("talid_webhook_events")
    .upsert(inbox, {
      onConflict: "provider,event_key",
      ignoreDuplicates: true,
    });

  if (inboxError) {
    return reply({ error: "Webhook inbox write failed" }, 500);
  }

  const customer = order?.customer ?? {};
  const statusText = str(
    order?.status ?? payload?.status
  ).toLowerCase();

  const statusMap: Record<string, string> = {
    new: "pending",
    pending: "pending",
    confirmed: "confirmed",
    processing: "processing",
    shipped: "shipped",
    delivered: "delivered",
    completed: "delivered",
    cancelled: "cancelled",
    canceled: "cancelled",
    returned: "returned",
    failed: "failed",
  };

  const status = statusMap[statusText] ?? "unknown";

  const row = {
    source: "easyorders",
    external_order_id: externalId,
    market_code: str(
      order?.market_code ??
      order?.country_code ??
      order?.country?.code
    ).toUpperCase() || null,
    customer_name: str(
      customer?.name ??
      order?.customer_name ??
      order?.name
    ) || null,
    customer_phone: str(
      customer?.phone ??
      order?.customer_phone ??
      order?.phone
    ) || null,
    status,
    amount: num(
      order?.total ??
      order?.total_price ??
      order?.amount
    ),
    currency: str(order?.currency ?? "EGP").toUpperCase(),
    raw_payload: payload,
    source_updated_at: new Date().toISOString(),
    ...(status === "delivered"
      ? { delivered_at: new Date().toISOString() }
      : {}),
  };

  const { error: orderError } = await db
    .from("talid_orders")
    .upsert(row, {
      onConflict: "source,external_order_id",
    });

  if (orderError) {
    await db.from("talid_webhook_events")
      .update({
        processing_status: "failed",
        last_error: orderError.message,
        error: orderError.message,
      })
      .eq("provider", "easyorders")
      .eq("event_key", eventKey);

    return reply({
      received: true,
      stored: true,
      order_synced: false,
    }, 500);
  }

  await db.from("talid_webhook_events")
    .update({
      processing_status: "processed",
      processed: true,
      processed_at: new Date().toISOString(),
    })
    .eq("provider", "easyorders")
    .eq("event_key", eventKey);

  return reply({
    received: true,
    order_synced: true,
    external_order_id: externalId,
  });
});
