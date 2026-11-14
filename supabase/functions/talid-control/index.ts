
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGIN =
  Deno.env.get("TALID_ALLOWED_ORIGIN") ||
  "https://younes-mohamed5.github.io";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  throw new Error("Missing Supabase environment variables");
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function isConnectionActive(connection: any | null): boolean {
  return ["active", "verified", "connected"].includes(String(connection?.status || "").toLowerCase());
}

const MARKET_CURRENCIES: Record<string,string> = {EG:"EGP",SA:"SAR",AE:"AED",OM:"OMR",IQ:"IQD"};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return response({ error: "Method not allowed" }, 405);
  }

  // Authenticate the current user.
  const authorization = req.headers.get("Authorization") || "";

  if (!authorization) {
    return response({ error: "Missing authorization" }, 401);
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        Authorization: authorization,
      },
    },
  });

  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser();

  if (authError || !user) {
    return response({ error: "Unauthorized" }, 401);
  }

  // Check the user's role and account status.
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("role,is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    console.error("Profile lookup error:", profileError.message);
    return response({ error: "Could not verify user permissions" }, 500);
  }

  if (
    !profile?.is_active ||
    !["owner", "admin"].includes(String(profile.role || "").toLowerCase())
  ) {
    return response({ error: "Forbidden" }, 403);
  }

  // Read the requested action.
  let body: any;

  try {
    body = await req.json();
  } catch {
    return response({ error: "Invalid JSON body" }, 400);
  }

  const action = String(body?.action || "").trim();

  // Write an audit record.
  const audit = async (
    actionName: string,
    result: string,
    details: string
  ) => {
    const { error } = await admin.from("talid_audit_logs").insert({
      actor_id: user.id,
      action: actionName,
      result,
      details,
    });

    if (error) {
      console.error("Audit log error:", error.message);
    }
  };

  // Load integrations and markets.
  const loadReadinessData = async () => {
    const {data: connections,error:connectionError}=await admin
      .from("integration_connections")
      .select("id,provider,display_name,status,config_public,created_at")
      .eq("provider","easyorders")
      .order("created_at",{ascending:false})
      .limit(1);
    if(connectionError) throw new Error(`EasyOrders connection lookup failed: ${connectionError.message}`);
    const connection=connections?.[0]||null;
    const config=(connection?.config_public||{}) as Record<string,unknown>;
    const countryCode=String(config.country_code||"").toUpperCase();
    const {data:country,error:countryError}=countryCode
      ? await admin.from("countries").select("id,code,name_ar,currency_code,is_enabled").eq("code",countryCode).maybeSingle()
      : {data:null,error:null};
    if(countryError) throw new Error(`Market lookup failed: ${countryError.message}`);
    return {connection,config,country,countryCode};
  };

  // One EasyOrders store is switched between markets. Readiness applies to
  // the currently confirmed store market, not all five markets simultaneously.
  const checkReadiness = async () => {
    const {connection,config,country,countryCode}=await loadReadinessData();
    const blockers:string[]=[];
    if(!connection || !isConnectionActive(connection)) blockers.push("اتصال EasyOrders غير نشط أو لم يتم التحقق منه");
    if(!countryCode || !MARKET_CURRENCIES[countryCode]) blockers.push("لم يتم تأكيد دولة متجر EasyOrders");
    if(!config.country_confirmed_at) blockers.push("يجب حفظ وتأكيد دولة المتجر في صفحة التكاملات");
    if(countryCode && !country) blockers.push("الدولة المحددة غير موجودة في جدول الدول");
    if(country && country.is_enabled!==true) blockers.push("السوق المحدد غير مفعل");
    return {ready:blockers.length===0,blockers,connection,country,country_code:countryCode,currency_code:MARKET_CURRENCIES[countryCode]||null};
  };

  try {
    // =====================================
    // READINESS
    // =====================================
    if (action === "readiness") {
      const result = await checkReadiness();

      await audit(
        "readiness",
        result.ready ? "passed" : "blocked",
        result.blockers.join(" | ") || "All readiness checks passed"
      );

      return response(result);
    }

    // =====================================
    // START
    // =====================================
    if (action === "start") {
      const result = await checkReadiness();

      if (!result.ready) {
        await audit(
          "runtime_start",
          "blocked",
          result.blockers.join(" | ")
        );

        return response({
          ready: false,
          blockers: result.blockers,
          message: "لا يمكن بدء التشغيل قبل استيفاء المتطلبات",
        }, 409);
      }

      const now = new Date().toISOString();

      const { data: runtime, error: runtimeError } = await admin
        .from("talid_runtime")
        .update({
          is_running: true,
          mode: "live",
          started_at: now,
          started_by: user.id,
        })
        .eq("id", 1)
        .select("*")
        .maybeSingle();

      if (runtimeError) {
        throw new Error(
          `Runtime update failed: ${runtimeError.message}`
        );
      }

      if (!runtime) {
        throw new Error("Runtime record with id=1 was not found");
      }

      const { error: jobError } = await admin
        .from("talid_jobs")
        .insert({
          job_type: "initial_sync",
        });

      if (jobError) {
        // Do not leave runtime active if its initial job could not be created.
        await admin
          .from("talid_runtime")
          .update({
            is_running: false,
            mode: "review",
          })
          .eq("id", 1);

        throw new Error(
          `Initial job creation failed: ${jobError.message}`
        );
      }

      await audit(
        "runtime_start",
        "success",
        "Runtime enabled after readiness checks"
      );

      return response({
        ready: true,
        running: true,
        message:
          "تم تفعيل وضع التشغيل وإضافة مهمة المزامنة الأولية. يجب التأكد من جاهزية العامل وموصلات API قبل تنفيذ المزامنة الفعلية.",
      });
    }

    // =====================================
    // STOP
    // =====================================
    if (action === "stop") {
      const { error } = await admin
        .from("talid_runtime")
        .update({
          is_running: false,
          mode: "review",
          stopped_at: new Date().toISOString(),
        })
        .eq("id", 1);

      if (error) {
        throw new Error(`Runtime stop failed: ${error.message}`);
      }

      await audit(
        "runtime_stop",
        "success",
        "Stopped by owner"
      );

      return response({
        success: true,
        running: false,
        message: "تم إيقاف المنصة وإعادتها إلى وضع المراجعة",
      });
    }

    // =====================================
    // PRODUCT AND ORDER SYNC REQUESTS
    // =====================================
    if (["sync_products", "sync_orders"].includes(action)) {
      const { data: runtime, error: runtimeError } = await admin
        .from("talid_runtime")
        .select("is_running,mode")
        .eq("id", 1)
        .maybeSingle();

      if (runtimeError) {
        throw new Error(
          `Runtime lookup failed: ${runtimeError.message}`
        );
      }

      if (!runtime?.is_running || runtime.mode !== "live") {
        return response({
          error: "Runtime stopped",
          message: "يجب أن تكون المنصة في وضع التشغيل",
        }, 409);
      }

      const { error: jobError } = await admin
        .from("talid_jobs")
        .insert({
          job_type: action,
        });

      if (jobError) {
        throw new Error(
          `Could not create sync job: ${jobError.message}`
        );
      }

      await audit(
        action,
        "queued",
        "Sync job added to queue"
      );

      return response({
        success: true,
        queued: true,
        job_type: action,
        message:
          "تمت إضافة المهمة إلى قائمة الانتظار. تنفيذ المزامنة الفعلية يحتاج إلى عامل تشغيل وموصل API موثق.",
      });
    }

    return response({
      error: "Unknown action",
      received_action: action,
    }, 400);

  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    console.error("TALID control error:", message);

    await audit(
      action || "unknown",
      "error",
      message
    );

    return response({
      error: "Internal server error",
      details: message,
    }, 500);
  }
});
