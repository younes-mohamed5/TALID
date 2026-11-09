
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("EASYORDERS_WEBHOOK_SECRET");

if (!SUPABASE_URL || !SERVICE_KEY) {
  throw new Error("Missing Supabase environment variables");
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function num(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function normalizeStatus(value: unknown): string {
  const status = str(value).toLowerCase();

  const map: Record<string, string> = {
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

  return map[status] ?? "pending";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method === "GET") {
    return reply({
      service: "TALID EasyOrders Webhook",
      status: "available",
    });
  }

  if (req.method !== "POST") {
    return reply({ error: "POST method required" }, 405);
  }

  if (!WEBHOOK_SECRET) {
    return reply({
      error: "EASYORDERS_WEBHOOK_SECRET is not configured",
    }, 503);
  }

  // EasyOrders webhook URL must include ?token=YOUR_SECRET
  const requestUrl = new URL(req.url);
  const suppliedSecret = requestUrl.searchParams.get("token");

  if (suppliedSecret !== WEBHOOK_SECRET) {
    return reply({ error: "Unauthorized" }, 401);
  }

  let payload: any;

  try {
    payload = await req.json();
  } catch {
    return reply({ error: "Invalid JSON payload" }, 400);
  }

  const order =
    payload?.order ??
    payload?.data?.order ??
    payload?.data ??
    payload;

  const externalId = str(
    order?.id ??
    order?.order_id ??
    order?.orderId ??
    payload?.order_id
  );

  if (!externalId) {
    return reply({ error: "Order ID is missing" }, 400);
  }

  const rawType = str(
    payload?.type ??
    payload?.event_type ??
    payload?.event ??
    ""
  ).toLowerCase();

  const eventType = rawType.includes("status")
    ? "order-status-update"
    : "orders";

  const eventKey =
    str(payload?.event_id ?? payload?.id) ||
    `${eventType}:${externalId}:${str(
      order?.updated_at ?? order?.status ?? "received"
    )}`;

  // Save webhook event
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
    return reply({
      error: "Could not save webhook event",
      details: inboxError.message,
    }, 500);
  }

  const customer = order?.customer ?? {};

  const status = normalizeStatus(
    order?.status ?? payload?.status
  );

  const currency = str(
    order?.currency ??
    order?.currency_code ??
    "EGP"
  ).toUpperCase();

  const totalAmount = num(
    order?.total ??
    order?.total_price ??
    order?.total_amount ??
    order?.amount
  );

  const marketCode = str(
    order?.market_code ??
    order?.country_code ??
    order?.country?.code ??
    "EG"
  ).toUpperCase();

  // Find the country in TALID
  let countryId: string | null = null;

  const { data: country, error: countryError } = await db
    .from("countries")
    .select("id")
    .eq("code", marketCode)
    .maybeSingle();

  if (!countryError && country) {
    countryId = country.id;
  }

  // Keep customer details in the order notes.
  // No assumption is made about the customers table structure.
  const customerDetails = {
    name: str(
      customer?.name ??
      order?.customer_name ??
      order?.name
    ),
    phone: str(
      customer?.phone ??
      order?.customer_phone ??
      order?.phone
    ),
    email: str(
      customer?.email ??
      order?.customer_email ??
      order?.email
    ),
    address: str(
      customer?.address ??
      order?.address
    ),
  };

  const orderNumber = `EO-${externalId}`;

  const orderRow: Record<string, unknown> = {
    order_number: orderNumber,
    source_channel: "easyorders",
    external_order_id: externalId,
    status,
    currency_code: currency,
    subtotal: totalAmount,
    total_amount: totalAmount,
    customer_notes: JSON.stringify(customerDetails),
    internal_notes: "Received from EasyOrders webhook",
  };

  if (countryId) {
    orderRow.country_id = countryId;
  }

  // Check whether this EasyOrders order already exists
  const { data: existingOrder, error: lookupError } = await db
    .from("orders")
    .select("id")
    .eq("source_channel", "easyorders")
    .eq("external_order_id", externalId)
    .maybeSingle();

  if (lookupError) {
    await db.from("talid_webhook_events")
      .update({
        processing_status: "failed",
        processed: false,
        error: lookupError.message,
      })
      .eq("provider", "easyorders")
      .eq("event_key", eventKey);

    return reply({
      received: true,
      order_synced: false,
      error: "Could not check existing order",
      details: lookupError.message,
    }, 500);
  }

  let savedOrderId: string | null = null;

  if (existingOrder) {
    const { data, error } = await db
      .from("orders")
      .update(orderRow)
      .eq("id", existingOrder.id)
      .select("id")
      .single();

    if (error) {
      await db.from("talid_webhook_events")
        .update({
          processing_status: "failed",
          processed: false,
          error: error.message,
        })
        .eq("provider", "easyorders")
        .eq("event_key", eventKey);

      return reply({
        received: true,
        order_synced: false,
        error: "Order update failed",
        details: error.message,
      }, 500);
    }

    savedOrderId = data.id;
  } else {
    const { data, error } = await db
      .from("orders")
      .insert(orderRow)
      .select("id")
      .single();

    if (error) {
      await db.from("talid_webhook_events")
        .update({
          processing_status: "failed",
          processed: false,
          error: error.message,
        })
        .eq("provider", "easyorders")
        .eq("event_key", eventKey);

      return reply({
        received: true,
        order_synced: false,
        error: "Order creation failed",
        details: error.message,
      }, 500);
    }

    savedOrderId = data.id;
  }

  // Mark webhook event as processed
  const { error: finishError } = await db
    .from("talid_webhook_events")
    .update({
      processing_status: "processed",
      processed: true,
      error: null,
      processed_at: new Date().toISOString(),
    })
    .eq("provider", "easyorders")
    .eq("event_key", eventKey);

  if (finishError) {
    return reply({
      received: true,
      order_synced: true,
      order_id: savedOrderId,
      warning: "Order saved, but event status update failed",
      details: finishError.message,
    }, 200);
  }

  return reply({
    success: true,
    received: true,
    order_synced: true,
    action: existingOrder ? "updated" : "created",
    order_id: savedOrderId,
    external_order_id: externalId,
  });
});
