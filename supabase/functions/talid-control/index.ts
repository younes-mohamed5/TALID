import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":
    Deno.env.get("TALID_ALLOWED_ORIGIN") || "https://YOUR-DOMAIN.example",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(supabaseUrl, serviceKey);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return response({ error: "Method not allowed" }, 405);
  }

  const authorization = req.headers.get("Authorization") || "";

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
  });

  const { data: { user } } = await userClient.auth.getUser();

  if (!user) return response({ error: "Unauthorized" }, 401);

  const { data: profile } = await admin
    .from("profiles")
    .select("role,is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (
    !profile?.is_active ||
    !["owner", "admin"].includes(profile.role)
  ) {
    return response({ error: "Forbidden" }, 403);
  }

  const { action } = await req.json().catch(() => ({}));

  const audit = async (
    actionName: string,
    result: string,
    details: string
  ) => {
    await admin.from("talid_audit_logs").insert({
      actor_id: user.id,
      action: actionName,
      result,
      details,
    });
  };

  if (action === "readiness") {
    const [{ data: integrations }, { data: markets }] =
      await Promise.all([
        admin.from("talid_integrations").select("*"),
        admin.from("talid_markets").select("*"),
      ]);

    const blockers: string[] = [];

    if (
      integrations?.find((x) => x.provider === "easyorders")?.status
      !== "verified"
    ) {
      blockers.push("EasyOrders غير موثق");
    }

    const activeMarkets = (markets || []).filter(
      (x) => x.is_enabled
    );

    if (
      !activeMarkets.length ||
      activeMarkets.some((x) => !x.provider_verified)
    ) {
      blockers.push("يجب تفعيل سوق موثق لدى Taager");
    }

    await audit(
      "readiness",
      blockers.length ? "blocked" : "passed",
      blockers.join("|")
    );

    return response({
      ready: !blockers.length,
      blockers,
      integrations,
      markets,
    });
  }

  if (action === "start") {
    const [{ data: integrations }, { data: markets }] =
      await Promise.all([
        admin.from("talid_integrations").select("*"),
        admin.from("talid_markets").select("*"),
      ]);

    const blockers: string[] = [];

    if (
      integrations?.find((x) => x.provider === "easyorders")?.status
      !== "verified"
    ) {
      blockers.push("EasyOrders غير موثق");
    }

    const activeMarkets = (markets || []).filter(
      (x) => x.is_enabled
    );

    if (
      !activeMarkets.length ||
      activeMarkets.some((x) => !x.provider_verified)
    ) {
      blockers.push("لا يوجد سوق موثق ومفعل");
    }

    if (blockers.length) {
      return response({ ready: false, blockers }, 409);
    }

    await admin.from("talid_runtime").update({
      is_running: true,
      mode: "live",
      started_at: new Date().toISOString(),
      started_by: user.id,
    }).eq("id", 1);

    await admin.from("talid_jobs").insert({
      job_type: "initial_sync",
    });

    await audit("runtime_start", "success", "Runtime enabled");

    return response({
      ready: true,
      message: "تم تفعيل وضع التشغيل. يلزم جدولة العامل.",
    });
  }

  if (action === "stop") {
    await admin.from("talid_runtime").update({
      is_running: false,
      mode: "review",
      stopped_at: new Date().toISOString(),
    }).eq("id", 1);

    await audit("runtime_stop", "success", "Stopped by owner");

    return response({ message: "تم الإيقاف" });
  }

  if (["sync_products", "sync_orders"].includes(action)) {
    const { data: runtime } = await admin
      .from("talid_runtime")
      .select("is_running")
      .eq("id", 1)
      .single();

    if (!runtime?.is_running) {
      return response({ error: "Runtime stopped" }, 409);
    }

    await admin.from("talid_jobs").insert({
      job_type: action,
    });

    return response({
      message: "تمت إضافة المهمة، وموصل API الفعلي ينتظر التحقق.",
    });
  }

  return response({ error: "Unknown action" }, 400);
});
