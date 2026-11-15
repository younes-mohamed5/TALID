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


async function readEasyOrdersProduct(productId: string, apiKey: string): Promise<Record<string, unknown>> {
  const url = new URL("https://api.easy-orders.net/api/v1/external-apps/products/" + encodeURIComponent(productId));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { "Api-Key": apiKey, "Accept": "application/json" },
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

  let requestBody: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object") requestBody = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400, origin);
  }

  const marketCurrencies: Record<string, string> = { EG: "EGP", SA: "SAR", AE: "AED", OM: "OMR", IQ: "IQD" };
  const { data: activeConnection, error: activeConnectionError } = await adminClient.from("integration_connections")
    .select("config_public").eq("provider", "easyorders").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (activeConnectionError) return json({ error: activeConnectionError.message }, 500, origin);
  const activeConfig = (activeConnection?.config_public || {}) as Record<string, unknown>;
  const configuredCountry = asText(activeConfig.country_code)?.toUpperCase();
  const requestedCountry = String(requestBody.country_code || configuredCountry || "").trim().toUpperCase();
  const requestedApiKey = requestedCountry && marketCurrencies[requestedCountry]
    ? (Deno.env.get("EASYORDERS_API_KEY_" + requestedCountry) || (configuredCountry === requestedCountry ? EASYORDERS_API_KEY : null))
    : null;

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

  // Send an approved product to the EasyOrders store selected for its market.
  if (requestBody.mode === "send_product") {
    const productId = asText(requestBody.product_id);
    const countryCode = String(requestBody.country_code || "").trim().toUpperCase();
    const currencyByCountry: Record<string,string> = { EG:"EGP", SA:"SAR", AE:"AED", OM:"OMR", IQ:"IQD" };
    const currency = currencyByCountry[countryCode];
    if (!productId || !currency) return json({ error:"اختر منتجاً وسوقاً صحيحاً." },400,origin);

    const marketKey = Deno.env.get("EASYORDERS_API_KEY_" + countryCode);
    const {data:connection,error:connectionError}=await adminClient.from("integration_connections")
      .select("config_public").eq("provider","easyorders").order("created_at",{ascending:false}).limit(1).maybeSingle();
    if(connectionError) return json({error:connectionError.message},500,origin);
    const config=(connection?.config_public||{}) as Record<string,unknown>;
    const configuredCountry=asText(config.country_code)?.toUpperCase();
    const apiKey=marketKey || (configuredCountry===countryCode ? EASYORDERS_API_KEY : null);
    if(!apiKey) return json({
      error:"لا يوجد مفتاح EasyOrders مخصص لسوق "+countryCode+". أضف السر EASYORDERS_API_KEY_"+countryCode+" في Supabase. لا يمكن توجيه منتج إلى متجر دولة أخرى باستخدام مفتاح متجر مختلف.",
      requested_country:countryCode,configured_country:configuredCountry,required_secret:"EASYORDERS_API_KEY_"+countryCode
    },409,origin);

    const {data:country,error:countryError}=await adminClient.from("countries").select("id,code,currency_code,name_ar").eq("code",countryCode).maybeSingle();
    if(countryError||!country) return json({error:"السوق المختار غير مسجل في جدول الدول."},400,origin);
    const {data:product,error:productError}=await adminClient.from("products")
      .select("id,sku,supplier_sku,supplier_product_id,name_ar,name_en,description,images,supplier_name,attributes,slug")
      .eq("id",productId).maybeSingle();
    if(productError||!product) return json({error:"المنتج غير موجود في كتالوج الجبيهى."},404,origin);
    const {data:price,error:priceError}=await adminClient.from("product_country_prices")
      .select("sale_price,currency_code,is_available").eq("product_id",productId).eq("country_id",country.id).maybeSingle();
    if(priceError||!price) return json({error:"لا يوجد سعر مسجل لهذا المنتج في السوق المختار."},409,origin);
    const salePrice=Number(price.sale_price);
    if(!Number.isFinite(salePrice)||salePrice<=0) return json({error:"أدخل سعر البيع اليدوي أولاً."},409,origin);
    if(String(price.currency_code||"").toUpperCase()!==currency) return json({error:"عملة سعر البيع لا تطابق عملة السوق المختار."},409,origin);
    if(price.is_available!==true) return json({error:"المنتج غير معتمد للبيع في هذا السوق. اعتمد صفحة الهبوط أولاً."},409,origin);
    const {data:landing,error:landingError}=await adminClient.from("product_landing_pages")
      .select("slug,status,sale_price,currency_code").eq("product_id",productId).eq("country_id",country.id).maybeSingle();
    if(landingError||!landing||landing.status!=="published") return json({error:"لا يمكن الإرسال قبل اعتماد ونشر صفحة الهبوط لهذا السوق."},409,origin);
    if(Number(landing.sale_price)!==salePrice||String(landing.currency_code||"").toUpperCase()!==currency) {
      return json({error:"سعر صفحة الهبوط لا يطابق سعر البيع المعتمد. احفظ السعر نفسه ثم اعتمد الصفحة."},409,origin);
    }

    const attrs=(product.attributes&&typeof product.attributes==="object"&&!Array.isArray(product.attributes)
      ? product.attributes : {}) as Record<string,unknown>;
    const sentMap=(attrs.easyorders_products_by_country&&typeof attrs.easyorders_products_by_country==="object"
      ? attrs.easyorders_products_by_country : {}) as Record<string,Record<string,unknown>>;
    const previous=sentMap[countryCode];
    if(previous && ["created","sending","pending_confirmation"].includes(String(previous.status))) {
      return json({error:"تم إرسال هذا المنتج من قبل أو أن نتيجة الإرسال السابق تحتاج مراجعة. لن نكرر الإرسال حتى لا يتكرر المنتج داخل EasyOrders.",already_sent:true,easyorders_product_id:previous.id||null,send_status:previous.status},409,origin);
    }

    const baseSku=asText(product.supplier_sku)||asText(product.sku)||productId;
    const remoteSku=(baseSku+"-"+countryCode).slice(0,100);
    const baseSlug=(asText(product.slug)||baseSku).toLowerCase().normalize("NFKD")
      .replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,65)||"geba ihy-product";
    const slug=(baseSlug+"-"+countryCode.toLowerCase()).slice(0,80);
    const images=Array.isArray(product.images)?product.images.map(asText).filter((x):x is string=>!!x).filter(x=>/^https:\/\//i.test(x)).slice(0,12):[];
    const name=asText(product.name_ar)||asText(product.name_en)||"منتج الجبيهى";
    const description=asText(product.description)||name;
    const payload={
      name,price:salePrice,sale_price:salePrice,description,slug,sku:remoteSku,
      ...(images.length?{thumb:images[0],images}:{}),
      quantity:0,track_stock:true,disable_orders_for_no_stock:true,
      buy_now_text:"اطلب الآن",is_reviews_enabled:false,is_free_shipping:false,
      ...(asText((attrs as Record<string,unknown>).taager_code)?{taager_code:asText((attrs as Record<string,unknown>).taager_code)}:{}),
      ...(asText(product.supplier_name)?{drop_shipping_provider:asText(product.supplier_name)}:{})
    };

    const pendingMap={...sentMap,[countryCode]:{status:"sending",sku:remoteSku,sale_price:salePrice,currency_code:currency,started_at:new Date().toISOString()}};
    const {error:lockError}=await adminClient.from("products").update({attributes:{...attrs,easyorders_products_by_country:pendingMap}}).eq("id",productId);
    if(lockError) return json({error:"تعذر تأمين سجل الإرسال لمنع التكرار: "+lockError.message},500,origin);

    let upstream:Response;
    try {
      upstream=await fetch("https://api.easy-orders.net/api/v1/external-apps/products",{
        method:"POST",headers:{"Api-Key":apiKey,"Accept":"application/json","Content-Type":"application/json"},
        body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)
      });
    } catch(error) {
      const uncertainMap={...pendingMap,[countryCode]:{...pendingMap[countryCode],status:"pending_confirmation"}};
      await adminClient.from("products").update({attributes:{...attrs,easyorders_products_by_country:uncertainMap}}).eq("id",productId);
      return json({error:"انقطع الاتصال أثناء الإرسال؛ قد يكون EasyOrders استلم المنتج. تم إيقاف إعادة المحاولة لمنع التكرار. راجع كتالوج EasyOrders أولاً.",pending_confirmation:true},502,origin);
    }
    const raw=await upstream.text();
    let result:unknown={};
    try{result=raw?JSON.parse(raw):{};}catch{result={raw:raw.slice(0,1000)};}
    if(!upstream.ok) {
      await adminClient.from("products").update({attributes:{...attrs,easyorders_products_by_country:{...sentMap,[countryCode]:{status:"failed",http_status:upstream.status,failed_at:new Date().toISOString()}}}}).eq("id",productId);
      const detail=result&&typeof result==="object"?((result as Record<string,unknown>).message||(result as Record<string,unknown>).error):null;
      const message=upstream.status===403
        ?"مفتاح EasyOrders لا يملك صلاحية products:create. فعّل الصلاحية ثم أعد المحاولة."
        :"رفض EasyOrders إنشاء المنتج (HTTP "+upstream.status+"). "+(asText(detail)||"راجع صلاحيات المفتاح وبيانات المنتج.");
      return json({error:message,upstream_status:upstream.status},502,origin);
    }
    const root=(result&&typeof result==="object"?result as Record<string,unknown>:{});
    const remote=(root.data&&typeof root.data==="object"?root.data as Record<string,unknown>:root);
    const remoteId=asText(remote.id)||asText(remote._id)||asText(remote.product_id);
    const finalMap={...sentMap,[countryCode]:{status:"created",id:remoteId,sku:remoteSku,sale_price:salePrice,currency_code:currency,created_at:new Date().toISOString()}};
    const {error:saveError}=await adminClient.from("products").update({attributes:{...attrs,easyorders_products_by_country:finalMap}}).eq("id",productId);
    await adminClient.from("sync_logs").insert({
      provider:"easyorders",entity_type:"products",direction:"outbound",status:"success",records_count:1,
      message:"Approved product sent from TALID product basket to the selected EasyOrders market.",
      details:{product_id:productId,country_code:countryCode,currency_code:currency,sale_price:salePrice,easyorders_sku:remoteSku,easyorders_product_id:remoteId}
    });
    return json({success:true,product_id:productId,country_code:countryCode,currency_code:currency,sale_price:salePrice,easyorders_sku:remoteSku,easyorders_product_id:remoteId,local_record_saved:!saveError,stock_safety:"quantity=0; orders disabled until stock is configured"},200,origin);
  }

  // Market-aware import: one master product can be assigned to multiple country catalogs.
  if (requestBody.mode === "import") {
    const limit = Math.max(1, Math.min(50, Math.floor(Number(requestBody.limit ?? 50) || 50)));
    const page = Math.max(1, Math.floor(Number(requestBody.page ?? 1) || 1));
    const requestedCountry = String(requestBody.country_code || "").trim().toUpperCase();
    const currencyByCountry: Record<string,string> = { EG:"EGP", SA:"SAR", AE:"AED", OM:"OMR", IQ:"IQD" };
    const targetCurrency = currencyByCountry[requestedCountry];
    if (!targetCurrency) return json({ error:"اختر سوقاً صحيحاً قبل الاستيراد." },400,origin);
    const {data:connection,error:connectionError}=await adminClient.from("integration_connections").select("config_public").eq("provider","easyorders").order("created_at",{ascending:false}).limit(1).maybeSingle();
    if(connectionError) return json({error:connectionError.message},500,origin);
    const config=(connection?.config_public||{}) as Record<string,unknown>;
    const configuredCountry=asText(config.country_code)?.toUpperCase();
    if(configuredCountry!==requestedCountry) return json({error:"الدولة المحددة في TALID لا تطابق الدولة المؤكدة في إعدادات EasyOrders. غيّر الدولة داخل EasyOrders ثم احفظها في TALID قبل الاستيراد.",configured_country:configuredCountry,requested_country:requestedCountry},409,origin);
    if(asText(config.country_confirmed_at)==null) return json({error:"أكد إعدادات الدولة في صفحة التكاملات قبل الاستيراد."},409,origin);
    const {data:country,error:countryError}=await adminClient.from("countries").select("id,code,currency_code").eq("code",requestedCountry).maybeSingle();
    if(countryError||!country) return json({error:"الدولة غير موجودة في جدول countries."},400,origin);
    const endpoint=new URL("https://api.easy-orders.net/api/v1/external-apps/products");
    endpoint.searchParams.set("page",String(page)); endpoint.searchParams.set("limit",String(limit));
    const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),25000);
    try {
      const upstream=await fetch(endpoint.toString(),{method:"GET",headers:{"Api-Key":requestedApiKey!,"Accept":"application/json"},signal:controller.signal});
      const raw=await upstream.text();
      if(!upstream.ok) return json({success:false,error:"EasyOrders rejected the catalog import.",upstream_status:upstream.status},502,origin);
      let payload:unknown; try{payload=JSON.parse(raw);}catch{return json({success:false,error:"EasyOrders returned non-JSON catalog data."},502,origin);}
      const sourceProducts=extractProducts(payload);
      let imported=0, linked=0, skipped=0, currencyMismatch=0, missingPrice=0;
      const errors:string[]=[];
      for(const source of sourceProducts){
        const sourceId=asText(source.id);
        const name=asText(source.name_ar)||asText(source.name)||asText(source.title);
        const sourceSku=asText(source.sku)||asText(source.taager_code);
        const sku=sourceSku||(sourceId?"EO-"+sourceId:null);
        if(!sourceId||!name||!sku){skipped++;continue;}
        const sourceCurrency=(asText(source.currency_code)||asText(source.currency)||"").toUpperCase();
        if(sourceCurrency && sourceCurrency!==targetCurrency){currencyMismatch++;continue;}
        const rawCost=source.sale_price??source.price;
        const cost=rawCost==null||rawCost===""?null:Number(rawCost);
        if(cost==null||!Number.isFinite(cost)||cost<0){missingPrice++;continue;}
        let product:any=null;
        const byId=await adminClient.from("products").select("id,sku,supplier_product_id,supplier_sku").eq("supplier_product_id",sourceId).limit(1).maybeSingle();
        if(byId.error) throw new Error(byId.error.message);
        product=byId.data;
        if(!product){
          const bySku=await adminClient.from("products").select("id,sku,supplier_product_id,supplier_sku").eq("sku",sku).limit(1).maybeSingle();
          if(bySku.error) throw new Error(bySku.error.message);
          product=bySku.data;
        }
        if(!product && sourceSku){
          const bySupplierSku=await adminClient.from("products").select("id,sku,supplier_product_id,supplier_sku").eq("supplier_sku",sourceSku).limit(1).maybeSingle();
          if(bySupplierSku.error) throw new Error(bySupplierSku.error.message);
          product=bySupplierSku.data;
        }
        if(!product){
          const slugBase=(asText(source.slug)||name).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,55)||"easyorders-product";
          const images=[...new Set([...(asText(source.thumb)?[asText(source.thumb)!]:[]),...(Array.isArray(source.images)?source.images.map(asText).filter((v):v is string=>!!v):[])])];
          const qtyRaw=source.quantity; const qty=qtyRaw==null||qtyRaw===""?null:Number(qtyRaw);
          const inserted=await adminClient.from("products").insert({sku,name_ar:name,slug:slugBase+"-"+sourceId.replace(/[^a-zA-Z0-9-]/g,"").slice(0,20),description:asText(source.description),supplier_name:"EasyOrders",supplier_product_id:sourceId,supplier_sku:sourceSku,cost_price:cost,sale_price:null,currency_code:targetCurrency,stock_qty:qty!=null&&Number.isFinite(qty)?Math.max(0,Math.floor(qty)):null,stock_status:qty==null?"unknown":qty>0?"in_stock":"out_of_stock",images,status:"draft",attributes:{source:"easyorders",taager_code:asText(source.taager_code)}}).select("id,sku").single();
          if(inserted.error){if(inserted.error.code==="23505"){skipped++;continue;}throw new Error(inserted.error.message);}
          product=inserted.data; imported++;
        }
        const existingPrice=await adminClient.from("product_country_prices").select("id").eq("product_id",product.id).eq("country_id",country.id).maybeSingle();
        if(existingPrice.error) throw new Error(existingPrice.error.message);
        if(existingPrice.data){skipped++;continue;}
        const priceInsert=await adminClient.from("product_country_prices").insert({product_id:product.id,country_id:country.id,cost_price:cost,sale_price:null,shipping_cost:null,currency_code:targetCurrency,is_available:false});
        if(priceInsert.error){if(priceInsert.error.code==="23505"){skipped++;continue;}throw new Error(priceInsert.error.message);}
        linked++;
      }
      await adminClient.from("sync_logs").insert({provider:"easyorders",entity_type:"products",direction:"inbound",status:"success",records_count:linked,message:"Market-scoped import; existing product master reused; per-market catalog assignment created.",details:{page,limit,country_code:requestedCountry,currency_code:targetCurrency,fetched:sourceProducts.length,new_master_products:imported,linked_to_market:linked,skipped,currency_mismatch:currencyMismatch,missing_price:missingPrice}});
      return json({success:true,mode:"import",page,country_code:requestedCountry,currency_code:targetCurrency,fetched:sourceProducts.length,imported,linked,skipped,currency_mismatch:currencyMismatch,missing_price:missingPrice,database_changed:linked>0,note:"Products are assigned only to the selected country catalog. Existing master products are reused; existing country assignments are skipped. Supplier price is cost, sale price remains unset."},200,origin);
    }catch(error){const timedOut=error instanceof DOMException&&error.name==="AbortError";return json({success:false,error:timedOut?"EasyOrders catalog import timed out.":(error instanceof Error?error.message:"Import failed.")},502,origin);}
    finally{clearTimeout(timeout);}
  }
  // Preview and authenticated single-product detail reads are read-only.
  if (requestBody.mode === "detail") {
    const productId = asText(requestBody.product_id);
    if (!productId) return json({ error: "product_id is required for detail mode." }, 400, origin);
    try {
      if (!requestedApiKey) return json({ error: "لا يوجد مفتاح API للسوق المحدد. أكد الدولة في التكاملات أو أضف EASYORDERS_API_KEY_" + requestedCountry + " في أسرار Supabase." }, 409, origin);\n      const product = await readEasyOrdersProduct(productId, requestedApiKey);
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

  if (!requestedCountry || !marketCurrencies[requestedCountry]) return json({ error: "اختر الدولة أولاً قبل معاينة كتالوج EasyOrders." }, 400, origin);\n  if (configuredCountry !== requestedCountry || !asText(activeConfig.country_confirmed_at)) return json({ error: "الدولة المختارة لا تطابق الدولة المؤكدة في إعدادات EasyOrders. غيّرها في EasyOrders ثم أكدها في تكاملات الجبيهى.", configured_country: configuredCountry, requested_country: requestedCountry }, 409, origin);\n  if (!requestedApiKey) return json({ error: "لا يوجد مفتاح API لسوق " + requestedCountry + ". أضف EASYORDERS_API_KEY_" + requestedCountry + " أو استخدم المفتاح الحالي بعد تأكيد الدولة المطابقة." }, 409, origin);\n\n  const requestedLimit = Number(requestBody.limit ?? 30);
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
        "Api-Key": requestedApiKey,
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
