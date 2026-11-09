
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
  "Access-Control-Allow-Headers":
    "content-type, x-talid-webhook-secret, secret",
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

function getOrderObject(payload: any): any {
  return (
    payload?.order ??
    payload?.data?.order ??
    payload?.data ??
    payload
  );
}

function getOrderItems(order: any): any[] | null {
  const items =
    order?.cart_items ??
    order?.items ??
    order?.order_items;

  return Array.isArray(items) ? items : null;
}

function normalizeOrderItem(item: any) {
  const product = item?.product ?? {};

  const quantity = Math.max(
    1,
    Math.floor(
      num(item?.quantity ?? product?.quantity ?? 1)
    )
  );

  const unitPrice = num(
    item?.price ??
    item?.unit_price ??
    product?.price ??
    0
  );

  return {
    product_name: str(
      product?.name ??
      item?.product_name ??
      item?.name ??
      "منتج بدون اسم"
    ),
    sku: str(
      product?.sku ??
      product?.taager_code ??
      item?.sku ??
      item?.product_sku
    ) || null,
    quantity,
    unit_price: unitPrice,
    unit_cost: 0,
  };
}

async function markEventFailed(
  eventKey: string,
  message: string
) {
  await db
    .from("talid_webhook_events")
    .update({
      processing_status: "failed",
      processed: false,
      error: message,
      last_error: message,
    })
    .eq("provider", "easyorders")
    .eq("event_key", eventKey);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method === "GET") {
    return reply({
      service: "TALID EasyOrders Webhook",
      status: "available",
      version: "4.0.0",
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

  // Verify EasyOrders webhook secret.
  const suppliedSecret =
    req.headers.get("x-talid-webhook-secret") ??
    req.headers.get("secret");

  if (!suppliedSecret || suppliedSecret !== WEBHOOK_SECRET) {
    return reply({ error: "Unauthorized" }, 401);
  }

  // Read request body.
  let payload: any;

  try {
    payload = await req.json();
  } catch {
    return reply({ error: "Invalid JSON payload" }, 400);
  }

  const order = getOrderObject(payload);

  // Get external order ID.
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

  const now = new Date().toISOString();

  // Save webhook event.
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
    error: null,
    last_error: null,
  };

  const { error: inboxError } = await db
    .from("talid_webhook_events")
    .upsert(inbox, {
      onConflict: "provider,event_key",
      ignoreDuplicates: true,
    });

  if (inboxError) {
    console.error("Webhook inbox error:", inboxError.message);

    return reply({
      error: "Could not save webhook event",
      details: inboxError.message,
    }, 500);
  }

  // Read actual EasyOrders order fields.
  const customer = order?.customer ?? {};

  const status = normalizeStatus(
    order?.new_status ??
    order?.status ??
    payload?.new_status ??
    payload?.status
  );

  const currency = str(
    order?.currency ??
    order?.currency_code ??
    order?.custom_currency ??
    "EGP"
  ).toUpperCase();

  // EasyOrders actual fields:
  // cost = products subtotal
  // shipping_cost = shipping
  // total_cost = final total

  const subtotal = num(
    order?.cost ??
    order?.subtotal ??
    order?.sub_total ??
    0
  );

  const shippingAmount = num(
    order?.shipping_cost ??
    order?.shipping_amount ??
    order?.shipping ??
    0
  );

  const totalAmount = num(
    order?.total_cost ??
    order?.total_amount ??
    order?.total ??
    order?.total_price ??
    (subtotal + shippingAmount)
  );

  const discountAmount = Math.max(
    0,
    subtotal + shippingAmount - totalAmount
  );

  const marketCode = str(
    order?.market_code ??
    order?.country_code ??
    order?.country?.code ??
    "EG"
  ).toUpperCase();

  // Find country.
  let countryId: string | null = null;

  const { data: country, error: countryError } = await db
    .from("countries")
    .select("id")
    .eq("code", marketCode)
    .maybeSingle();

  if (countryError) {
    console.error("Country lookup:", countryError.message);
  }

  if (country) {
    countryId = country.id;
  }

  // Customer details.
  const customerDetails = {
    name: str(
      customer?.name ??
      customer?.full_name ??
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

  // Prepare TALID order row.
  const orderRow: Record<string, unknown> = {
    order_number: orderNumber,
    source_channel: "easyorders",
    external_order_id: externalId,
    status,
    currency_code: currency,
    subtotal,
    shipping_amount: shippingAmount,
    discount_amount: discountAmount,
    total_amount: totalAmount,
    supplier_cost: 0,
    ad_cost: 0,
    other_cost: 0,
    customer_notes: JSON.stringify(customerDetails),
    internal_notes: "Received from EasyOrders webhook",
    updated_at: now,
  };

  if (countryId) {
    orderRow.country_id = countryId;
  }

  // Find existing order.
  const { data: existingOrder, error: lookupError } = await db
    .from("orders")
    .select("id")
    .eq("source_channel", "easyorders")
    .eq("external_order_id", externalId)
    .maybeSingle();

  if (lookupError) {
    await markEventFailed(eventKey, lookupError.message);

    return reply({
      received: true,
      order_synced: false,
      error: "Could not check existing order",
      details: lookupError.message,
    }, 500);
  }

  let savedOrderId: string | null = null;
  let action = "created";

  // Update existing order or create new order.
  if (existingOrder) {
    const { data, error } = await db
      .from("orders")
      .update(orderRow)
      .eq("id", existingOrder.id)
      .select("id")
      .single();

    if (error) {
      await markEventFailed(eventKey, error.message);

      return reply({
        received: true,
        order_synced: false,
        error: "Order update failed",
        details: error.message,
      }, 500);
    }

    savedOrderId = data.id;
    action = "updated";
  } else {
    const { data, error } = await db
      .from("orders")
      .insert(orderRow)
      .select("id")
      .single();

    if (error) {
      await markEventFailed(eventKey, error.message);

      return reply({
        received: true,
        order_synced: false,
        error: "Order creation failed",
        details: error.message,
      }, 500);
    }

    savedOrderId = data.id;
  }

  // Sync product items only when the webhook includes an items array.
  // This prevents status-only updates from deleting existing items.
  const incomingItems = getOrderItems(order);

  let itemsInserted = 0;

  if (incomingItems !== null) {
    const normalizedItems = incomingItems
      .map(normalizeOrderItem)
      .filter((item) => item.product_name && item.quantity > 0);

    // Remove previous items before inserting the latest snapshot.
    const { error: deleteError } = await db
      .from("order_items")
      .delete()
      .eq("order_id", savedOrderId);

    if (deleteError) {
      await markEventFailed(eventKey, deleteError.message);

      return reply({
        received: true,
        order_synced: true,
        items_synced: false,
        error: "Could not replace previous order items",
        details: deleteError.message,
      }, 500);
    }

    if (normalizedItems.length > 0) {
      // line_total is generated by the database.
      // Do not send line_total in the insert.
      const itemRows = normalizedItems.map((item) => ({
        order_id: savedOrderId,
        product_name: item.product_name,
        sku: item.sku,
        quantity: item.quantity,
        unit_price: item.unit_price,
        unit_cost: item.unit_cost,
      }));

      const { error: itemsError } = await db
        .from("order_items")
        .insert(itemRows);

      if (itemsError) {
        await markEventFailed(eventKey, itemsError.message);

        return reply({
          received: true,
          order_synced: true,
          items_synced: false,
          error: "Could not save order items",
          details: itemsError.message,
        }, 500);
      }

      itemsInserted = itemRows.length;
    }
  }

  // Mark webhook event as processed.
  const { error: finishError } = await db
    .from("talid_webhook_events")
    .update({
      processing_status: "processed",
      processed: true,
      error: null,
      last_error: null,
      processed_at: now,
    })
    .eq("provider", "easyorders")
    .eq("event_key", eventKey);

  if (finishError) {
    console.error("Event update error:", finishError.message);

    return reply({
      success: true,
      order_synced: true,
      items_inserted: itemsInserted,
      warning: "Order saved but event status update failed",
      details: finishError.message,
    }, 200);
  }

  return reply({
    success: true,
    received: true,
    order_synced: true,
    items_synced: incomingItems !== null,
    items_inserted: itemsInserted,
    action,
    order_id: savedOrderId,
    external_order_id: externalId,
    order_number: orderNumber,
    subtotal,
    shipping_amount: shippingAmount,
    discount_amount: discountAmount,
    total_amount: totalAmount,
    currency,
    event_type: eventType,
  });
});
