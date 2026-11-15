
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const cfg = window.TALID_CONFIG || {};

  let db = null;
  let currentPage = "overview";
  let currentUser = null;
  let loginInProgress = false;
  let navigationReady = false;

  const pages = {
    overview: "لوحة التشغيل",
    products: "المنتجات والكتالوج",
    orders: "الطلبات والتسليم",
    markets: "الدول والأسعار",
    profit: "الأرباح والمستحقات",
    campaigns: "التسويق والحملات",
    integrations: "التكاملات والجاهزية",
    activity: "سجل التشغيل",
    settings: "الإعدادات"
  };

  const tables = {
    products: "products",
    orders: "orders",
    markets: "talid_markets",
    campaigns: "marketing_campaigns",
    activity: "talid_audit_logs"
  };

  // =========================================
  // أدوات عامة
  // =========================================

  function escapeHTML(value) {
    return String(value ?? "-").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[char]);
  }

  function notify(message) {
    const toast = $("toast");
    if (!toast) return;

    toast.textContent = message;
    toast.hidden = false;
    toast.style.display = "block";

    clearTimeout(notify.timer);

    notify.timer = setTimeout(() => {
      toast.style.display = "none";
      toast.hidden = true;
    }, 4000);
  }

  function showError(container, message) {
    if (!container) return;

    container.innerHTML = `
      <div class="panel">
        <h3>تعذر تحميل البيانات</h3>
        <p class="muted">${escapeHTML(message)}</p>
      </div>`;
  }

  // =========================================
  // القائمة الجانبية - إصلاح شامل
  // =========================================

  function getSidebar() {
    return $("app")?.querySelector("aside");
  }

  function isMobileScreen() {
    return window.matchMedia("(max-width: 760px)").matches;
  }

  function closeSidebar() {
    const sidebar = getSidebar();
    const menuButton = $("menu");

    if (sidebar) {
      sidebar.classList.remove("open");
    }

    if (menuButton) {
      menuButton.setAttribute("aria-expanded", "false");
      menuButton.setAttribute("aria-label", "فتح القائمة");
    }
  }

  function openSidebar() {
    const sidebar = getSidebar();
    const menuButton = $("menu");

    if (!sidebar) return;

    sidebar.classList.add("open");

    if (menuButton) {
      menuButton.setAttribute("aria-expanded", "true");
      menuButton.setAttribute("aria-label", "إغلاق القائمة");
    }
  }

  function toggleSidebar() {
    const sidebar = getSidebar();

    if (!sidebar) return;

    if (sidebar.classList.contains("open")) {
      closeSidebar();
    } else {
      openSidebar();
    }
  }

  function setupSidebar() {
    const menuButton = $("menu");
    const sidebar = getSidebar();

    if (!sidebar || navigationReady) return;

    navigationReady = true;

    closeSidebar();

    // زر فتح وإغلاق القائمة
    if (menuButton) {
      menuButton.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleSidebar();
      };
    }

    // إغلاق القائمة عند اختيار أي قسم
    const navigation = sidebar.querySelector("nav");

    if (navigation) {
      navigation.addEventListener("click", (event) => {
        const button = event.target.closest(
          "button[data-page]"
        );

        if (!button) return;

        closeSidebar();
      }, true);
    }

    // إغلاق القائمة عند الضغط خارجها
    document.addEventListener("click", (event) => {
      if (!isMobileScreen()) return;
      if (!sidebar.classList.contains("open")) return;

      const insideSidebar = sidebar.contains(event.target);
      const insideMenu = menuButton &&
        menuButton.contains(event.target);

      if (!insideSidebar && !insideMenu) {
        closeSidebar();
      }
    });

    // إغلاق القائمة بزر Escape
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeSidebar();
      }
    });

    // إغلاق القائمة عند تغيير حجم الشاشة
    window.addEventListener("resize", () => {
      if (!isMobileScreen()) {
        closeSidebar();
      }
    });
  }

  // =========================================
  // الاتصال بـ Supabase
  // =========================================

  async function invokeControl(action) {
    const {
      data: { session },
      error: sessionError
    } = await db.auth.getSession();

    if (sessionError) throw sessionError;

    if (!session) {
      throw new Error(
        "انتهت جلسة الدخول. سجل الدخول مرة أخرى."
      );
    }

    const { data, error } = await db.functions.invoke(
      "talid-control",
      {
        body: { action }
      }
    );

    if (error) {
      let details =
        error.message || "تعذر الاتصال بدالة التشغيل";

      if (
        error.context &&
        typeof error.context.json === "function"
      ) {
        try {
          const body = await error.context.json();

          details =
            body.blockers?.join("، ") ||
            body.error ||
            body.message ||
            details;
        } catch (_) {}
      }

      throw new Error(details);
    }

    if (data?.error) {
      throw new Error(data.error);
    }

    return data;
  }

  async function getRows(table, limit = 100) {
    const { data, error } = await db
      .from(table)
      .select("*")
      .limit(limit);

    if (error) throw error;

    return data || [];
  }

  async function getCount(table) {
    const { count, error } = await db
      .from(table)
      .select("*", {
        count: "exact",
        head: true
      });

    if (error) throw error;

    return count || 0;
  }

  // =========================================
  // عرض الجداول
  // =========================================

  function renderTable(container, rows) {
    if (!container) return;

    if (!rows.length) {
      container.innerHTML = `
        <div class="panel">
          <p class="muted">
            لا توجد بيانات مسجلة حتى الآن.
          </p>
        </div>`;
      return;
    }

    const columns = Object.keys(rows[0]);

    container.innerHTML = `
      <div class="panel" style="overflow:auto">
        <table>
          <thead>
            <tr>
              ${columns.map(col => `
                <th>${escapeHTML(col)}</th>
              `).join("")}
            </tr>
          </thead>

          <tbody>
            ${rows.map(row => `
              <tr>
                ${columns.map(col => {
                  const value = row[col];

                  const display =
                    value !== null &&
                    typeof value === "object"
                      ? JSON.stringify(value)
                      : value;

                  return `
                    <td>${escapeHTML(display)}</td>
                  `;
                }).join("")}
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>`;
  }

  // =========================================
  // لوحة التشغيل
  // =========================================

  async function renderOverview() {
    const view = $("view");

    view.innerHTML = `
      <div class="panel">
        جارٍ فحص حالة المنصة وتحميل البيانات...
      </div>`;

    const [
      ordersCount,
      productsCount,
      markets,
      runtime
    ] = await Promise.all([
      getCount("orders"),
      getCount("products"),
      getRows("talid_markets"),
      db.from("talid_runtime")
        .select("*")
        .eq("id", 1)
        .maybeSingle()
    ]);

    if (runtime.error) throw runtime.error;

    const isRunning = runtime.data?.is_running === true;

    $("notice").textContent = isRunning
      ? "المنصة في وضع التشغيل."
      : "حالة التشغيل: متوقفة. استخدم فحص الجاهزية لمعرفة المتطلبات قبل تفعيل التشغيل.";


    view.innerHTML = `
      <div class="head">
        <div>
          <h1>مرحبًا بك في الجبيهى</h1>
          <p class="muted">
            منصة متابعة التجارة والطلبات والأسواق
          </p>
        </div>

        <button id="runControl">
          ${isRunning ? "إيقاف التشغيل" : "فحص الجاهزية وبدء التشغيل"}
        </button>
      </div>

      <div class="cards">
        <div class="card">
          <small>إجمالي الطلبات</small>
          <div class="num">${ordersCount}</div>
        </div>

        <div class="card">
          <small>إجمالي المنتجات</small>
          <div class="num">${productsCount}</div>
        </div>

        <div class="card">
          <small>الدول المسجلة</small>
          <div class="num">${markets.length}</div>
        </div>

        <div class="card">
          <small>حالة التشغيل</small>
          <div class="num">
            ${isRunning ? "نشطة" : "متوقفة"}
          </div>
        </div>
      </div>

      <div class="grid">
        <div class="panel">
          <h3>الأسواق</h3>

          ${
            markets.length
              ? markets.map(m => `
                <div class="line">
                  <span>${escapeHTML(m.country_name)}</span>
                  <b>${m.is_enabled ? "مفعلة" : "متوقفة"}</b>
                </div>
              `).join("")
              : `
                <p class="muted">
                  لم تتم إضافة الدول بعد.
                </p>
              `
          }
        </div>

        <div class="panel">
          <h3>طريقة العمل</h3>

          <p class="muted">
            EasyOrders هي نقطة الربط الوحيدة للكتالوج والطلبات.
            وهي متصلة بحساب Taager الخاص بك لتنفيذ الطلبات.
          </p>

          <p class="muted">
            الجبيهى تدير أسواقك وأسعارك وتكاليفك وتحلل النتائج.
          </p>

          <p class="muted">
            الجبيهى تتابع البيانات وتحلل النتائج.
            لا يتم إنفاق إعلانات أو تنفيذ قرارات مالية دون موافقتك.
          </p>
        </div>
      </div>
    `;

    $("runControl").onclick = async () => {
      const button = $("runControl");
      button.disabled = true;

      try {
        const result = await invokeControl(
          isRunning ? "stop" : "start"
        );

        notify(result.message || "تم إرسال طلب التشغيل.");
        await render("overview");
      } catch (error) {
        notify(error.message);
        button.disabled = false;
      }
    };
  }


  // =========================================
  // كتالوج المنتجات - عرض السجلات الفعلية فقط
  // =========================================
  async function renderProducts() {
    const [countryResult, productResult] = await Promise.all([
      db.from("countries").select("id,code,name_ar,currency_code,currency_symbol").in("code",["EG","SA","AE","OM","IQ"]).order("code"),
      db.from("products").select("id,sku,supplier_sku,supplier_product_id,name_ar,name_en,description,supplier_name,images,cost_price,sale_price,currency_code,stock_status,status,updated_at").order("updated_at",{ascending:false}).limit(500)
    ]);
    if(countryResult.error) throw countryResult.error;
    if(productResult.error) throw productResult.error;
    const countries=countryResult.data||[], products=productResult.data||[];
    const view=$("view");
    view.innerHTML=`
      <div class="head"><div><h1>${pages.products}</h1><p class="muted">خمسة كتالوجات مستقلة داخل حساب EasyOrders واحد. كل منتج يُربط بالسوق الذي استُورد منه فقط.</p></div><span class="badge">${countries.length} أسواق</span></div>
      <div class="panel">
        <h3>اختر كتالوج الدولة</h3>
        <select id="catalogCountry" style="width:100%;padding:12px;border:1px solid #d8deea;border-radius:10px">
          ${countries.map(x=>'<option value="'+escapeHTML(x.code)+'">'+escapeHTML(x.name_ar)+' — '+escapeHTML(x.currency_code)+'</option>').join("")}
        </select>
        <p id="catalogMarketNotice" class="muted">الاستيراد متاح فقط عندما تطابق الدولة المختارة الدولة التي أكّدتها في إعدادات EasyOrders بعد تغييرها داخل المتجر.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="easyOrdersPreview" type="button">معاينة كتالوج الدولة</button>
          <button id="easyOrdersImport" type="button">استيراد منتجات هذه الدولة</button>
        </div>
        <div id="easyOrdersPreviewResult" aria-live="polite" style="margin-top:12px"></div>
      </div>
      <div class="panel">
        <h3>إضافة منتج يدوياً إلى السوق المحدد</h3>
        <form id="manualProductForm" style="display:grid;gap:9px">
          <input id="manualName" required placeholder="اسم المنتج">
          <input id="manualSku" required placeholder="SKU / كود المورد">
          <textarea id="manualDescription" rows="3" placeholder="وصف المنتج ومواصفاته"></textarea>
          <input id="manualCost" type="number" min="0" step="0.01" required placeholder="تكلفة المورد بعملة السوق">
          <input id="manualShipping" type="number" min="0" step="0.01" placeholder="تكلفة الشحن بعملة السوق">
          <input id="manualSale" type="number" min="0" step="0.01" placeholder="سعر البيع المعتمد (اختياري)">
          <textarea id="manualImages" rows="2" placeholder="روابط الصور، رابط في كل سطر"></textarea>
          <button id="manualSave" type="submit">حفظ المنتج في كتالوج هذه الدولة</button>
        </form>
      </div>
      <div class="panel"><h3>سلة إرسال المنتجات إلى EasyOrders</h3><p class="muted">حدد المنتجات المعتمدة في السوق المختار، ثم أرسلها دفعة واحدة. لن يُرسل أي منتج قبل اعتماد صفحة الهبوط وسعر البيع.</p><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px"><span id="sendSelectionCount" class="badge">0 منتجات محددة</span><button id="sendSelectedToEasyOrders" type="button" disabled>إرسال المحدد إلى EasyOrders</button></div><input id="productSearch" type="search" placeholder="بحث بالاسم أو SKU" style="width:100%;padding:12px;margin-bottom:12px"><div id="productRows">جارٍ تحميل المنتجات...</div><div id="sendBasketResult" aria-live="polite"></div></div>
      <div id="landingBuilder"></div>
    `;
    const countrySelect=$("catalogCountry");
    const money=(v,code)=>v==null?"غير محدد":new Intl.NumberFormat("ar-EG",{maximumFractionDigits:2}).format(Number(v))+" "+code;
    let marketPrices=[];
    let marketProducts=[];
    const selectedForSend=new Set();
    async function loadMarket(){
      const market=countries.find(x=>x.code===countrySelect.value);
      const {data:prices,error}=await db.from("product_country_prices").select("id,product_id,cost_price,sale_price,shipping_cost,currency_code,is_available").eq("country_id",market.id);
      if(error)throw error;
      marketPrices=prices||[];
      const ids=marketPrices.map(x=>x.product_id);
      marketProducts=products.filter(p=>ids.includes(p.id));
      $("catalogMarketNotice").textContent="كتالوج "+market.name_ar+" مستقل — العملة "+market.currency_code+" — المنتجات المرتبطة بهذا السوق: "+marketProducts.length+".";
      selectedForSend.clear();
      drawProducts();
    }
    function updateSendSelection(){
      const count=$("sendSelectionCount"),button=$("sendSelectedToEasyOrders");
      count.textContent=selectedForSend.size+" منتجات محددة";
      button.disabled=selectedForSend.size===0;
    }
    function drawProducts(){
      const q=($("productSearch").value||"").toLowerCase().trim();
      const priceMap=new Map(marketPrices.map(x=>[x.product_id,x]));
      const rows=marketProducts.filter(p=>[p.name_ar,p.name_en,p.sku,p.supplier_sku].some(v=>String(v||"").toLowerCase().includes(q)));
      $("productRows").innerHTML=rows.length?'<div style="overflow:auto"><table><thead><tr><th>اختيار</th><th>المنتج</th><th>SKU</th><th>تكلفة المورد</th><th>سعر البيع</th><th>العملة</th><th>الحالة</th><th>صفحة الهبوط</th></tr></thead><tbody>'+rows.map(p=>{
        const pr=priceMap.get(p.id)||{};
        const cover=Array.isArray(p.images)?p.images.find(x=>typeof x==="string"&&/^https:\/\//i.test(x)):"";
        return '<tr><td><input type="checkbox" data-select-send="'+escapeHTML(p.id)+'" '+(selectedForSend.has(p.id)?"checked":"")+(pr.is_available&&Number(pr.sale_price)>0?"":" disabled")+' aria-label="تحديد المنتج للإرسال"></td><td><div style="display:flex;align-items:center;gap:9px;min-width:180px">'+(cover?'<img src="'+escapeHTML(cover)+'" alt="" loading="lazy" style="width:64px;height:64px;object-fit:contain;border-radius:8px;background:#f5f0e5">':'<span style="width:64px;height:64px;display:grid;place-items:center;background:#f5f0e5;border-radius:8px">—</span>')+'<strong>'+escapeHTML(p.name_ar||p.name_en)+'</strong></div></td><td>'+escapeHTML(p.sku||"-")+'</td><td>'+money(pr.cost_price,pr.currency_code||"")+'</td><td>'+money(pr.sale_price,pr.currency_code||"")+'</td><td>'+escapeHTML(pr.currency_code||"")+'</td><td>'+(pr.is_available&&Number(pr.sale_price)>0?"معتمد":"بانتظار الاعتماد") +'</td><td><div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" data-auto-landing="'+escapeHTML(p.id)+'">إنشاء صفحة الهبوط</button><button type="button" data-build-landing="'+escapeHTML(p.id)+'">عرض وتعديل</button></div></td></tr>';
      }).join("")+'</tbody></table></div>':'<p class="muted">لا توجد منتجات في كتالوج هذه الدولة بعد. استورد الكتالوج أو أضف منتجاً يدوياً.</p>';
      $("productRows").querySelectorAll("[data-select-send]").forEach(ch=>ch.onchange=()=>{
        if(ch.checked)selectedForSend.add(ch.dataset.selectSend);else selectedForSend.delete(ch.dataset.selectSend);
        updateSendSelection();
      });
      updateSendSelection();
      $("productRows").querySelectorAll("[data-build-landing]").forEach(b=>b.onclick=()=>showLandingBuilder(b.dataset.buildLanding));
      $("productRows").querySelectorAll("[data-auto-landing]").forEach(b=>b.onclick=async()=>{
        const id=b.dataset.autoLanding,product=marketProducts.find(x=>x.id===id);
        if(!product)return;
        b.disabled=true;b.textContent="جارٍ الإنشاء...";
        try{
          showLandingBuilder(id);
          const name=product.name_ar||product.name_en||"منتج مميز";
          const description=String(product.description||"").trim();
          const marketCopy={
            EG:{intro:"اختيارك الذكي يبدأ من هنا. اكتشف تفاصيل المنتج واطلبه بسهولة داخل مصر.",cta:"اطلب الآن"},
            SA:{intro:"اكتشف المنتج بتفاصيل واضحة وتجربة طلب سهلة داخل المملكة العربية السعودية.",cta:"اطلبه الآن"},
            AE:{intro:"اكتشف المنتج واستمتع بتجربة تسوق واضحة وسهلة داخل الإمارات العربية المتحدة.",cta:"اطلب الآن"},
            OM:{intro:"تعرّف على المنتج واطلبه بخطوات بسيطة داخل سلطنة عُمان.",cta:"اطلب الآن"},
            IQ:{intro:"اكتشف تفاصيل المنتج وأكمل طلبك بسهولة داخل العراق.",cta:"اطلب الآن"}
          }[market.code]||{intro:"اكتشف المنتج وأكمل طلبك بسهولة.",cta:"اطلب الآن"};
          const generatedHeadline=name+" — اختيارك المميز";
          const generatedSub=marketCopy.intro;
          const generatedBody=[
            "مرحبًا بك في الجبيهى",
            "",
            "نقدم لك "+name+" ضمن اختيارات الجبيهى لسوق "+market.name_ar+".",
            description?("تفاصيل المنتج:\\n"+description):"تعرّف على المنتج من الصور والتفاصيل المتاحة قبل اتخاذ قرار الشراء.",
            "",
            "لماذا تطلب من الجبيهى؟",
            "• تفاصيل واضحة للمنتج قبل الطلب.",
            "• سعر بيع محدد بعملة السوق المختار.",
            "• خطوات طلب سهلة ومباشرة.",
            "",
            "راجع الصور والتفاصيل والسعر المعروض، ثم أرسل طلبك."
          ].join("\\n");
          $("lpHeadline").value=generatedHeadline;
          $("lpSubheadline").value=generatedSub;
          $("lpBody").value=generatedBody;
          $("lpImages").value=(Array.isArray(product.images)?product.images:[]).join("\\n");
          $("lpSale").value="";
          $("lpStatus").textContent="تم إعداد محتوى صفحة هبوط مخصص لسوق "+market.name_ar+". أدخل سعر البيع يدويًا ثم احفظ المسودة. لن تُنشر الصفحة تلقائيًا.";
          $("landingEditor").scrollIntoView({behavior:"smooth",block:"start"});
          notify("تم إنشاء مسودة الصفحة لسوق "+market.name_ar+". أدخل سعر البيع يدويًا واحفظها.");
        }catch(error){notify("تعذر إنشاء الصفحة: "+error.message);}
        finally{b.disabled=false;b.textContent="إنشاء صفحة تلقائيًا";}
      });
    }
    function showLandingBuilder(productId){
      let savedLandingSlug=null;
      const p=marketProducts.find(x=>x.id===productId), market=countries.find(x=>x.code===countrySelect.value), pr=marketPrices.find(x=>x.product_id===productId)||{};
      if(!p||!market)return;
      const images=Array.isArray(p.images)?p.images:[];
      $("landingBuilder").innerHTML=`
        <div class="panel" id="landingEditor">
          <h3>منشئ صفحة الهبوط — ${escapeHTML(market.name_ar)}</h3>
          <p class="muted">المنتج: ${escapeHTML(p.name_ar||p.name_en)} — العملة: ${escapeHTML(market.currency_code)}</p>
          <input id="lpHeadline" value="${escapeHTML(p.name_ar||p.name_en||"عرض مميز")}" placeholder="عنوان الصفحة">
          <input id="lpSubheadline" placeholder="عنوان فرعي جذاب">
          <textarea id="lpBody" rows="5" placeholder="تفاصيل المنتج ومميزاته">${escapeHTML(p.description||"")}</textarea>
          <label>روابط الصور (سطر لكل صورة)</label><textarea id="lpImages" rows="3">${escapeHTML(images.join("\n"))}</textarea>
          <div class="grid">
            <input id="lpCost" type="number" min="0" step="0.01" value="${pr.cost_price??p.cost_price??""}" placeholder="تكلفة المورد">
            <input id="lpShipping" type="number" min="0" step="0.01" value="${pr.shipping_cost??""}" placeholder="الشحن">
            <input id="lpMargin" type="number" min="1" max="90" value="30" placeholder="هامش الربح %">
            <input id="lpSale" type="number" min="0" step="0.01" value="" placeholder="سعر البيع اليدوي — مطلوب قبل النشر">
          </div>
          <h4>مقارنة المنافسين (أدخل اسم المنافس والسعر المرصود، سطر لكل منافس)</h4>
          <textarea id="lpCompetitors" rows="3" placeholder="اسم المنافس | السعر | رابط صفحة المنتج"></textarea>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button id="lpSuggestPrice" type="button">تحليل السعر المقترح</button>
            <button id="lpSaveDraft" type="button">إنشاء صفحة الهبوط وحفظها</button><button id="lpPublish" type="button" disabled>نشر صفحة الهبوط</button>
          </div>
          <p id="lpStatus" class="muted">يُحسب السعر من التكلفة والشحن والهامش، وتُستخدم أسعار المنافسين التي تدخلها أنت فقط. لا يتم اختلاق بيانات منافسين.</p>
          <div id="lpPreview"></div>
        </div>`;
      const costEl=$("lpCost"),shipEl=$("lpShipping"),marginEl=$("lpMargin"),saleEl=$("lpSale"),status=$("lpStatus");
      $("lpSuggestPrice").onclick=()=>{
        const cost=Number(costEl.value),shipping=Number(shipEl.value||0),margin=Number(marginEl.value||30);
        if(!Number.isFinite(cost)||cost<=0||margin<=0||margin>=90){status.textContent="أدخل تكلفة صحيحة وهامشاً بين 1 و89%.";return;}
        const competitorRows=$("lpCompetitors").value.split("\n").map(line=>line.split("|")).filter(parts=>parts.length>=2&&Number.isFinite(Number(parts[1]))&&Number(parts[1])>0);
        const floor=(cost+shipping)/(1-margin/100);
        const avg=competitorRows.length?competitorRows.reduce((s,x)=>s+Number(x[1]),0)/competitorRows.length:null;
        const suggested=avg==null?floor:Math.max(floor,avg*0.97);
        saleEl.value=suggested.toFixed(2);
        status.textContent="السعر المقترح: "+money(suggested,market.currency_code)+". أساس الحساب: التكلفة + الشحن + هامش "+margin+"%"+(avg==null?"؛ لا توجد أسعار منافسين مدخلة.":"؛ متوسط أسعار المنافسين المدخلة "+money(avg,market.currency_code)+".");
      };
      $("lpSaveDraft").onclick=async()=>{
        const button=$("lpSaveDraft");button.disabled=true;
        try{
          const headline=$("lpHeadline").value.trim(),body=$("lpBody").value.trim(),sale=Number(saleEl.value);
          const cost=Number(costEl.value),shipping=Number(shipEl.value||0);
          if(!headline||!body||!Number.isFinite(cost)||cost<0||(!Number.isFinite(sale)&&saleEl.value.trim()!=="")||(saleEl.value.trim()!==""&&sale<=0))throw new Error("أكمل العنوان والوصف والتكلفة. سعر البيع اختياري عند حفظ المسودة، لكنه إلزامي قبل النشر.");
          const {error:priceError}=await db.from("product_country_prices").upsert({product_id:p.id,country_id:market.id,cost_price:cost,shipping_cost:shipping,sale_price:saleEl.value.trim()?sale:null,currency_code:market.currency_code,is_available:false},{onConflict:"product_id,country_id"});
          if(priceError)throw priceError;
          const competitorData=$("lpCompetitors").value.split("\n").map(line=>line.split("|")).filter(parts=>parts.length>=2).map(parts=>({name:parts[0].trim(),price:Number(parts[1]),url:(parts[2]||"").trim()})).filter(x=>x.name&&Number.isFinite(x.price)&&x.price>0);
          const slug=(p.sku||p.id).toLowerCase().replace(/[^a-z0-9-]+/g,"-").replace(/^-+|-+$/g,"")+"-"+market.code.toLowerCase();
          const pageData={product_id:p.id,country_id:market.id,slug,headline,subheadline:$("lpSubheadline").value.trim(),body,benefits:[],images:$("lpImages").value.split("\n").map(x=>x.trim()).filter(Boolean),sale_price:saleEl.value.trim()?sale:null,currency_code:market.currency_code,seo_title:headline,seo_description:body.slice(0,155),competitor_analysis:{source:"admin_entered",competitors:competitorData,average_price:competitorData.length?competitorData.reduce((s,x)=>s+x.price,0)/competitorData.length:null,shipping_cost:shipping,margin_percent:Number(marginEl.value||30)},status:"ready_for_review",created_by:currentUser?.id||null,updated_at:new Date().toISOString()};
          const {error:pageError}=await db.from("product_landing_pages").upsert(pageData,{onConflict:"product_id,country_id"});
          if(pageError)throw pageError;
          savedLandingSlug=slug;
          $("lpPublish").disabled=false;
          status.textContent=saleEl.value.trim()?"تم حفظ الصفحة للمراجعة. راجعها ثم اعتمد النشر عند الاستعداد.":"تم حفظ الصفحة كمسودة. أدخل سعر البيع يدويًا قبل الاعتماد والنشر.";
          $("lpPreview").innerHTML='<a target="_blank" rel="noopener" href="landing.html?slug='+encodeURIComponent(slug)+'">فتح رابط المعاينة بعد النشر</a>.';
          notify("تم حفظ صفحة الهبوط والسعر لهذا السوق.");
        }catch(error){status.textContent=error.message;notify(error.message);}
        finally{button.disabled=false;}
      };
      $("lpPublish").onclick=async()=>{
        if(!savedLandingSlug){status.textContent="احفظ صفحة الهبوط أولاً.";return;}
        if(!Number.isFinite(Number(saleEl.value))||Number(saleEl.value)<=0){status.textContent="أدخل سعر البيع يدويًا واحفظه قبل نشر الصفحة.";notify("سعر البيع اليدوي مطلوب قبل النشر.");return;}
        if(!confirm("هل تعتمد نشر صفحة المنتج بسعر "+money(Number(saleEl.value),market.currency_code)+" في سوق "+market.name_ar+"؟"))return;
        const button=$("lpPublish");button.disabled=true;
        try{
          const {error:pageError}=await db.from("product_landing_pages").update({status:"published",published_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("slug",savedLandingSlug).eq("country_id",market.id);
          if(pageError)throw pageError;
          const {error:priceError}=await db.from("product_country_prices").update({is_available:true}).eq("product_id",p.id).eq("country_id",market.id);
          if(priceError)throw priceError;
          const {error:productError}=await db.from("products").update({status:"active",updated_at:new Date().toISOString()}).eq("id",p.id);
          if(productError)throw productError;
          // Storefront visibility still requires a published landing page and an approved price for the selected country.\n          const url=new URL("landing.html",location.href);url.searchParams.set("slug",savedLandingSlug);
          $("lpPreview").innerHTML='<a target="_blank" rel="noopener" href="'+escapeHTML(url.href)+'">فتح صفحة الهبوط المنشورة</a>';
          status.textContent="تم نشر صفحة الهبوط للسوق "+market.name_ar+".";
          notify("تم نشر صفحة الهبوط.");
        }catch(error){status.textContent="تعذر النشر: "+error.message;button.disabled=false;}
      };
    }
    countrySelect.addEventListener("change",()=>loadMarket().catch(e=>showError($("productRows"),e.message)));
    $("productSearch").addEventListener("input",drawProducts);
    $("sendSelectedToEasyOrders").onclick=async()=>{
      const market=countries.find(x=>x.code===countrySelect.value),ids=[...selectedForSend];
      if(!market||!ids.length)return;
      if(!confirm("سيتم إرسال "+ids.length+" منتج معتمد إلى متجر EasyOrders المرتبط بسوق "+market.name_ar+". هل تريد المتابعة؟"))return;
      const button=$("sendSelectedToEasyOrders"),result=$("sendBasketResult");
      button.disabled=true;let sent=0,failed=0;
      result.innerHTML="";
      for(const id of ids){
        const product=marketProducts.find(x=>x.id===id);
        const row=document.createElement("div");row.className="notice";row.textContent="جارٍ إرسال: "+(product?.name_ar||product?.name_en||id);result.appendChild(row);
        try{
          const {data,error}=await db.functions.invoke("easyorders-catalog-sync",{body:{mode:"send_product",product_id:id,country_code:market.code}});
          if(error){let message=error.message||"تعذر الاتصال بوظيفة الإرسال";if(error.context&&typeof error.context.json==="function"){try{const detail=await error.context.json();message=detail.error||message;}catch(_){}}throw new Error(message);}
          if(!data?.success)throw new Error(data?.error||"لم يؤكد EasyOrders إنشاء المنتج.");
          sent++;row.textContent="تم الإرسال: "+(product?.name_ar||product?.name_en)+" — "+money(data.sale_price,data.currency_code)+" — SKU: "+data.easyorders_sku;
          selectedForSend.delete(id);
        }catch(error){failed++;row.textContent="لم يتم الإرسال: "+(product?.name_ar||product?.name_en)+" — "+error.message;}
      }
      updateSendSelection();button.disabled=selectedForSend.size===0;
      notify("نتيجة الإرسال: "+sent+" ناجح، "+failed+" يحتاج مراجعة.");
      if(sent)await loadMarket();
    };
    $("manualProductForm").addEventListener("submit",async event=>{
      event.preventDefault();const button=$("manualSave");button.disabled=true;
      try{
        const market=countries.find(x=>x.code===countrySelect.value),sku=$("manualSku").value.trim(),name=$("manualName").value.trim(),cost=Number($("manualCost").value);
        if(!market||!name||!sku||!Number.isFinite(cost)||cost<0)throw new Error("أدخل اسم المنتج والكود والتكلفة.");
        let product=(await db.from("products").select("id").eq("sku",sku).maybeSingle());
        if(product.error)throw product.error;
        let productId=product.data?.id;
        if(!productId){
          const slug=(sku+"-"+market.code).toLowerCase().replace(/[^a-z0-9-]+/g,"-").replace(/^-+|-+$/g,"");
          const inserted=await db.from("products").insert({sku,name_ar:name,slug,description:$("manualDescription").value.trim(),supplier_name:"manual",currency_code:market.currency_code,cost_price:cost,sale_price:null,images:$("manualImages").value.split("\n").map(x=>x.trim()).filter(Boolean),status:"draft",attributes:{source:"admin_manual"}}).select("id").single();
          if(inserted.error)throw inserted.error;productId=inserted.data.id;
        }
        const {error}=await db.from("product_country_prices").upsert({product_id:productId,country_id:market.id,cost_price:cost,shipping_cost:Number($("manualShipping").value||0),sale_price:$("manualSale").value?Number($("manualSale").value):null,currency_code:market.currency_code,is_available:false},{onConflict:"product_id,country_id"});
        if(error)throw error;notify("تمت إضافة المنتج إلى كتالوج "+market.name_ar+".");await renderProducts();
      }catch(error){notify("تعذر حفظ المنتج: "+error.message);button.disabled=false;}
    });
    $("easyOrdersPreview").onclick=async()=>{
      const button=$("easyOrdersPreview"),box=$("easyOrdersPreviewResult"),market=countries.find(x=>x.code===countrySelect.value);button.disabled=true;box.textContent="جارٍ قراءة كتالوج EasyOrders...";
      try{
        const {data,error}=await db.functions.invoke("easyorders-catalog-sync",{body:{mode:"preview",country_code:market.code,limit:50}});
        if(error){let message=error.message||"تعذر الاتصال بـ EasyOrders";if(error.context&&typeof error.context.json==="function"){try{const detail=await error.context.json();message=detail.error||message;}catch(_){}}throw new Error(message);}
        if(!data?.success)throw new Error(data?.error||"فشلت المعاينة.");
        const items=data.preview||[];
        box.innerHTML='<div class="notice">تم العثور على '+items.length+' منتج في كتالوج '+escapeHTML(market.name_ar)+'. هذه معاينة كاملة قبل الاستيراد؛ لا يتم نشر المنتجات تلقائيًا.</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:12px">'+items.map(x=>{
          const pics=Array.isArray(x.images)?x.images.filter(v=>typeof v==="string"&&/^https:\/\//i.test(v)):[],cover=x.image||pics[0]||"";
          return '<article class="panel" style="padding:12px;min-width:0"><div style="height:155px;background:#f5f0e5;border-radius:10px;display:grid;place-items:center;overflow:hidden">'+(cover?'<img src="'+escapeHTML(cover)+'" alt="'+escapeHTML(x.name)+'" style="width:100%;height:100%;object-fit:contain">':'<span>لا توجد صورة</span>')+'</div><h4 style="margin:10px 0 6px">'+escapeHTML(x.name)+'</h4><div class="muted">SKU: '+escapeHTML(x.sku||"غير متاح")+'</div><div class="muted">كود المورد: '+escapeHTML(x.taager_code||"غير متاح")+'</div><strong>تكلفة المورد: '+escapeHTML(money(x.price,x.currency||market.currency_code))+'</strong><div class="muted">المخزون: '+escapeHTML(x.quantity??"غير محدد")+' — الصور: '+pics.length+'</div><details style="margin-top:8px"><summary>كل بيانات المنتج</summary><p style="white-space:pre-wrap">'+escapeHTML(x.description||"لا يوجد وصف من المصدر")+'</p><p>السعر الأصلي: '+escapeHTML(money(x.original_price,x.currency||market.currency_code))+'</p><p>الرابط المختصر: '+escapeHTML(x.slug||"غير متاح")+'</p>'+'<p>العلامة التجارية: '+escapeHTML(x.brand||"غير محددة")+'</p><p>الوزن: '+escapeHTML(x.weight??"غير محدد")+'</p><p>الخصائص والمتغيرات: '+escapeHTML(JSON.stringify({categories:x.categories||[],variations:x.variations||[],variants:x.variants||[],attributes:x.attributes||{}}))+'</p>'+(pics.length?pics.map(src=>'<img src="'+escapeHTML(src)+'" alt="" loading="lazy" style="width:64px;height:64px;object-fit:contain;margin:3px;border-radius:6px">').join(""):"")+'</details></article>';
        }).join("")+'</div>';
      }catch(error){box.textContent=error.message;}finally{button.disabled=false;}
    };
    $("easyOrdersImport").onclick=async()=>{
      const button=$("easyOrdersImport"),previewButton=$("easyOrdersPreview"),box=$("easyOrdersPreviewResult"),market=countries.find(x=>x.code===countrySelect.value);
      if(!market)return;
      if(!confirm("هل غيّرت دولة EasyOrders يدوياً إلى "+market.name_ar+" وحفظت نفس الدولة في التكاملات؟ سيتم ربط المنتجات بهذا السوق فقط."))return;
      button.disabled=true;previewButton.disabled=true;let imported=0,linked=0,skipped=0,fetched=0,pages=0;
      try{
        for(let page=1;page<=100;page++){
          box.textContent="جارٍ استيراد منتجات "+market.name_ar+" — صفحة "+page;
          const {data,error}=await db.functions.invoke("easyorders-catalog-sync",{body:{mode:"import",country_code:market.code,page,limit:50}});
          if(error){let message=error.message||"تعذر الاستيراد";if(error.context&&typeof error.context.json==="function"){try{const x=await error.context.json();message=x.error||message;}catch(_){}}throw new Error(message);}
          if(!data?.success)throw new Error(data?.error||"فشل استيراد الصفحة");
          imported+=Number(data.imported||0);linked+=Number(data.linked||0);skipped+=Number(data.skipped||0);fetched+=Number(data.fetched||0);pages++;
          if(Number(data.fetched||0)<50)break;
        }
        box.innerHTML='<div class="notice">اكتمل كتالوج '+escapeHTML(market.name_ar)+': منتجات رئيسية جديدة '+imported+'، روابط سوق جديدة '+linked+'، متجاوزة '+skipped+'، مقروءة '+fetched+'.</div>';
        notify("اكتملت مزامنة سوق "+market.name_ar);await renderProducts();
      }catch(error){box.textContent="توقفت المزامنة بعد "+pages+" صفحات: "+error.message;notify(error.message);}
      finally{button.disabled=false;previewButton.disabled=false;}
    };
    await loadMarket();
  }

  // =========================================
  // الأسواق
  // =========================================

  async function renderMarkets() {
    const markets = await getRows("talid_markets", 20);
    const view = $("view");
    const normalizedMarkets = markets.map((market) => ({
      code: String(market.code || market.country_code || "").toUpperCase(),
      name: market.name_ar || market.country_name || market.code || market.country_code,
      currency: String(market.currency || ({
        EG: "EGP", SA: "SAR", AE: "AED", OM: "OMR", IQ: "IQD"
      }[String(market.code || market.country_code || "").toUpperCase()] || ""))
    })).filter((market) => market.code);

    view.innerHTML = `
      <div class="head">
        <div>
          <h1>${pages.markets}</h1>
          <p class="muted">اختر سوقًا لعرض منتجاته وأسعاره المسجلة في قاعدة البيانات.</p>
        </div>
        <span class="badge">وضع المراجعة — لا يتم تفعيل الأسواق تلقائيًا</span>
      </div>
      <div class="panel">
        <label for="marketSelector"><b>السوق الحالي</b></label>
        <select id="marketSelector" style="display:block;width:100%;max-width:420px;margin-top:10px;padding:12px;border:1px solid #d8deea;border-radius:10px;background:#fff">
          ${normalizedMarkets.map((market) => `
            <option value="${escapeHTML(market.code)}">${escapeHTML(market.name)} — ${escapeHTML(market.currency || "عملة غير محددة")}</option>
          `).join("")}
        </select>
        <div id="marketSummary" class="muted" style="margin-top:12px"></div>
      </div>
      <div id="marketProducts" aria-live="polite">
        <div class="panel">جارٍ تحميل منتجات السوق...</div>
      </div>
    `;

    const selector = $("marketSelector");
    if (!normalizedMarkets.length) {
      $("marketProducts").innerHTML = '<div class="panel">لا توجد أسواق مسجلة في talid_markets.</div>';
      return;
    }

    async function loadMarket(code) {
      const market = normalizedMarkets.find((item) => item.code === code);
      const target = $("marketProducts");
      const summary = $("marketSummary");
      target.innerHTML = '<div class="panel">جارٍ تحميل أسعار ومنتجات السوق...</div>';

      const { data: country, error: countryError } = await db
        .from("countries")
        .select("id,code,name_ar,currency_code,currency_symbol,is_enabled")
        .eq("code", code)
        .maybeSingle();

      if (countryError) throw countryError;

      const currency = country?.currency_code || market?.currency || "عملة غير محددة";
      const currencyLabel = country?.currency_symbol || currency;
      summary.textContent = country
        ? `${country.name_ar} • العملة: ${currency} (${currencyLabel}) • حالة الدولة في countries: ${country.is_enabled ? "مفعلة" : "غير مفعلة"}`
        : `${market?.name || code} • العملة: ${currency} • لم يتم العثور على سجل مطابق في جدول countries.`;

      if (!country?.id) {
        target.innerHTML = '<div class="panel"><p>لا يمكن عرض أسعار هذا السوق لأن الدولة غير موجودة في جدول countries. لم يتم تعديل أي بيانات.</p></div>';
        return;
      }

      const { data: prices, error: priceError } = await db
        .from("product_country_prices")
        .select("product_id,sale_price,cost_price,shipping_cost,currency_code,is_available")
        .eq("country_id", country.id)
        .order("sale_price", { ascending: true });

      if (priceError) throw priceError;

      const priceRows = prices || [];
      const productIds = [...new Set(priceRows.map((row) => row.product_id).filter(Boolean))];

      if (!productIds.length) {
        target.innerHTML = `
          <div class="panel">
            <h3>لا توجد أسعار مسجلة لهذا السوق بعد</h3>
            <p class="muted">السوق ${escapeHTML(market?.name || code)} مسجل، لكن جدول product_country_prices لا يحتوي على أسعار مرتبطة به حتى الآن.</p>
            <p class="muted">لن نعرض أسعارًا افتراضية أو نفعّل السوق دون بيانات مؤكدة.</p>
          </div>`;
        return;
      }

      const { data: products, error: productsError } = await db
        .from("products")
        .select("id,sku,name_ar,name_en,status")
        .in("id", productIds);

      if (productsError) throw productsError;

      const productMap = new Map((products || []).map((product) => [product.id, product]));
      const formatter = (value) => value == null || value === ""
        ? "غير محدد"
        : new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 2 }).format(Number(value));

      target.innerHTML = `
        <div class="panel">
          <h3>منتجات ${escapeHTML(market?.name || code)}</h3>
          <p class="muted">عدد سجلات الأسعار: ${priceRows.length} — العملة المعروضة: ${escapeHTML(currency)}</p>
          <div style="overflow:auto">
            <table>
              <thead><tr>
                <th>المنتج</th><th>SKU / Taager Code</th><th>سعر البيع</th><th>تكلفة المورد</th><th>الشحن</th><th>الهامش الأولي</th><th>التوفر</th>
              </tr></thead>
              <tbody>
                ${priceRows.map((price) => {
                  const product = productMap.get(price.product_id) || {};
                  const margin = price.sale_price != null && price.cost_price != null
                    ? Number(price.sale_price) - Number(price.cost_price)
                    : null;
                  return `<tr>
                    <td>${escapeHTML(product.name_ar || product.name_en || "منتج غير معروف")}</td>
                    <td>${escapeHTML(product.sku || "غير مسجل")}</td>
                    <td>${escapeHTML(formatter(price.sale_price))} ${escapeHTML(price.currency_code || currency)}</td>
                    <td>${escapeHTML(formatter(price.cost_price))} ${escapeHTML(price.currency_code || currency)}</td>
                    <td>${escapeHTML(formatter(price.shipping_cost))} ${escapeHTML(price.currency_code || currency)}</td>
                    <td>${margin == null ? "غير قابل للحساب" : escapeHTML(formatter(margin) + " " + (price.currency_code || currency))}</td>
                    <td>${price.is_available ? "متاح حسب السجل" : "غير متاح"}</td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>
          <p class="muted">الهامش الأولي = سعر البيع − تكلفة المورد فقط؛ ولا يمثل صافي الربح قبل خصم الشحن والإعلانات والخصومات والمرتجعات.</p>
        </div>`;
    }

    selector.addEventListener("change", async () => {
      try {
        await loadMarket(selector.value);
      } catch (error) {
        showError($("marketProducts"), error.message);
      }
    });

    try {
      await loadMarket(selector.value);
    } catch (error) {
      showError($("marketProducts"), error.message);
    }
  }


  // =========================================
  // الحملات - إنشاء مسودات ومراجعة الميزانية بالجنيه
  // =========================================
  async function renderCampaigns() {
    const [campaignResult, countryResult] = await Promise.all([
      db.from("marketing_campaigns").select("id,name,platform,country_id,status,budget,currency_code,start_at,end_at,created_at").order("created_at",{ascending:false}).limit(200),
      db.from("countries").select("id,code,name_ar,currency_code").order("code")
    ]);
    if (campaignResult.error) throw campaignResult.error;
    if (countryResult.error) throw countryResult.error;
    const campaigns = campaignResult.data || [];
    const countries = countryResult.data || [];
    const countryMap = new Map(countries.map(c => [c.id,c]));
    const view = $("view");
    view.innerHTML = `
      <div class="head"><div><h1>${pages.campaigns}</h1>
      <p class="muted">ميزانية كل حملة تُحفظ بعملة السوق الذي تستهدفه، دون خلط عملات الأسواق المختلفة.</p></div>
      <span class="badge">لا نشر ولا إنفاق تلقائي</span></div>
      <div class="panel">
        <h3>إنشاء حملة — مسودة للمراجعة فقط</h3>
        <form id="campaignForm" style="display:grid;gap:10px">
          <input id="campaignName" required maxlength="120" placeholder="اسم الحملة">
          <select id="campaignPlatform" required>
            <option value="meta">Meta (Facebook / Instagram)</option>
            <option value="other">منصة أخرى</option>
          </select>
          <select id="campaignCountry" required>
            <option value="">اختر السوق المستهدف</option>
            ${countries.map(c => `<option value="${escapeHTML(c.id)}">${escapeHTML(c.name_ar)} — ${escapeHTML(c.code)}</option>`).join("")}
          </select>
          <label id="campaignBudgetLabel" for="campaignBudget">الميزانية بعملة السوق</label>
          <input id="campaignBudget" type="number" min="0" step="0.01" required placeholder="0.00">
          <button id="saveCampaign" type="submit">حفظ كمسودة</button>
        </form>
        <p class="muted">حفظ المسودة لا ينشئ إعلانًا ولا يربط بطاقة دفع ولا ينفق أي أموال.</p>
      </div>
      <div class="panel"><h3>الحملات المسجلة</h3><div id="campaignRows"></div></div>`;
    const currencyForCountry = (country) => String(country?.currency_code || ({EG:"EGP",SA:"SAR",AE:"AED",OM:"OMR",IQ:"IQD"}[country?.code] || "غير محددة")).toUpperCase();
    const updateCampaignCurrency = () => {
      const country = countryMap.get($("campaignCountry").value);
      const currency = currencyForCountry(country);
      $("campaignBudgetLabel").textContent = "الميزانية بعملة " + (country?.name_ar || "السوق") + " (" + currency + ")";
    };
    $("campaignCountry").addEventListener("change", updateCampaignCurrency);
    updateCampaignCurrency();

    $("campaignForm").addEventListener("submit", async event => {
      event.preventDefault();
      const button = $("saveCampaign");
      button.disabled = true;
      try {
        const budget = Number($("campaignBudget").value);
        if (!Number.isFinite(budget) || budget < 0) throw new Error("أدخل ميزانية صحيحة بعملة السوق المختار.");
        const selectedCountry = countryMap.get($("campaignCountry").value);
        if (!selectedCountry) throw new Error("اختر سوقاً صحيحاً للحملة.");
        const campaignCurrency = currencyForCountry(selectedCountry);
        const {error} = await db.from("marketing_campaigns").insert({
          name: $("campaignName").value.trim(),
          platform: $("campaignPlatform").value,
          country_id: $("campaignCountry").value,
          status: "draft",
          budget,
          currency_code: campaignCurrency,
          content: {approval_required: true, publishing_enabled: false}
        });
        if (error) throw error;
        notify("تم حفظ الحملة كمسودة بعملة " + campaignCurrency + ". لم يتم نشر إعلان.");
        await renderCampaigns();
      } catch (error) {
        notify("تعذر حفظ المسودة: " + error.message);
        button.disabled = false;
      }
    });
    const target = $("campaignRows");
    if (!campaigns.length) {
      target.innerHTML = '<p class="muted">لا توجد حملات مسجلة حتى الآن.</p>';
      return;
    }
    const fmt = (v,currency) => {
      if(v==null) return "غير محددة";
      try{return new Intl.NumberFormat("ar-EG",{style:"currency",currency:currency||"EGP",maximumFractionDigits:2}).format(Number(v));}
      catch(_){return new Intl.NumberFormat("ar-EG",{maximumFractionDigits:2}).format(Number(v))+" "+(currency||"");}
    };
    target.innerHTML = `<div style="overflow:auto"><table>
      <thead><tr><th>الحملة</th><th>المنصة</th><th>السوق</th><th>الميزانية</th><th>العملة</th><th>الحالة</th><th>الإجراء</th></tr></thead>
      <tbody>${campaigns.map(c => `<tr>
        <td>${escapeHTML(c.name)}</td><td>${escapeHTML(c.platform)}</td>
        <td>${escapeHTML(countryMap.get(c.country_id)?.name_ar || "غير محدد")}</td>
        <td>${fmt(c.budget,c.currency_code || currencyForCountry(countryMap.get(c.country_id)))}</td><td>${escapeHTML(c.currency_code || currencyForCountry(countryMap.get(c.country_id)))}</td>
        <td>${escapeHTML(c.status)}</td>
        <td>${["draft","pending_approval","paused"].includes(c.status) ? `<button type="button" data-campaign-id="${escapeHTML(c.id)}" data-next-status="draft">إبقاء كمسودة</button>` : "لا يوجد إجراء آمن"}</td>
      </tr>`).join("")}</tbody></table></div>
      <p class="muted">الحملات القديمة التي لا تحمل عملة مسجلة تظهر كما هي للمراجعة؛ لا يتم تخمين عملتها أو تحويل قيمها تلقائيًا.</p>`;
    target.querySelectorAll("button[data-campaign-id]").forEach(button => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const {error} = await db.from("marketing_campaigns")
            .update({status:"draft"})
            .eq("id",button.dataset.campaignId);
          if (error) throw error;
          notify("تم إبقاء الحملة في وضع المسودة.");
          await renderCampaigns();
        } catch(error) {
          notify("تعذر تحديث الحملة: " + error.message);
          button.disabled = false;
        }
      });
    });
  }

  // =========================================
  // التكاملات
  // =========================================

  async function renderIntegrations() {
    const webhookCount = await getCount("talid_webhook_events");

    $("view").innerHTML = `
      <div class="head">
        <h1>${pages.integrations}</h1>
        <button id="readiness">فحص الجاهزية</button>
      </div>

      <div class="panel">
        <h3>إعداد متجر EasyOrders والسوق</h3>
        <p class="muted">حدد الدولة التي يعمل عليها حساب EasyOrders، وأدخل رابط متجرك لفتحه مباشرة من لوحة الإدارة. تُستخدم عملة الدولة تلقائياً في كتالوج الجبيهى.</p>
        <label for="easyOrdersCountry">دولة متجر EasyOrders</label>
        <select id="easyOrdersCountry" style="display:block;width:100%;padding:12px;margin:8px 0 14px;border:1px solid #d8deea;border-radius:10px">
          <option value="">اختر الدولة</option>
          <option value="EG">مصر – EGP</option>
          <option value="SA">السعودية – SAR</option>
          <option value="AE">الإمارات – AED</option>
          <option value="OM">عُمان – OMR</option>
          <option value="IQ">العراق – IQD</option>
        </select>
        <label for="easyOrdersStoreUrl">رابط متجر EasyOrders (اختياري)</label>
        <input id="easyOrdersStoreUrl" type="url" placeholder="https://your-store..." style="display:block;width:100%;padding:12px;margin:8px 0 14px;border:1px solid #d8deea;border-radius:10px">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="saveEasyOrdersStore" type="button">حفظ الدولة وإعدادات المتجر</button>
          <button id="openEasyOrdersStore" type="button" class="secondary">الدخول إلى المتجر</button>
        </div>
        <p id="easyOrdersStoreStatus" class="muted" aria-live="polite">جارٍ تحميل إعدادات المتجر...</p>
      </div>

      <div class="panel">
        <h3>حالة التكاملات</h3>
        <div id="integrationTable"><p class="muted">جارٍ تحميل حالة اتصال EasyOrders...</p></div>
        <p class="muted">عدد أحداث Webhook المستلمة: ${webhookCount}</p>
        <p class="muted">لا يتم اعتبار أي تكامل نشطًا قبل اختبار الاتصال والتحقق من الصلاحيات والبيانات الفعلية.</p>
      </div>
    `;

    const storeStatus = $("easyOrdersStoreStatus");
    try {
      const { data, error } = await db.functions.invoke("easyorders-catalog-sync", { body: { mode: "get_store_config" } });
      if (error) throw error;
      const store = data?.store || {};
      $("easyOrdersCountry").value = store.country_code || "";
      $("easyOrdersStoreUrl").value = store.store_url || "";
      storeStatus.textContent = store.country_code
        ? "الدولة الحالية: " + store.country_code + " – العملة: " + (store.currency_code || "غير محددة") + " – حالة الاتصال: " + (store.status || "غير محددة")
        : "لم يتم تحديد دولة المتجر بعد.";
      $("integrationTable").innerHTML = '<div class="line"><span>EasyOrders — ' + escapeHTML(store.country_code || "لم تُحدد الدولة") + '</span><b>' + escapeHTML(store.status || "غير مهيأ") + '</b></div><p class="muted">Taager متصلة من خلال EasyOrders؛ لا يلزم تسجيل تكامل Taager مستقل داخل الجبيهى.</p>';
    } catch (error) {
      storeStatus.textContent = "تعذر تحميل إعدادات المتجر: " + error.message;
    }

    $("saveEasyOrdersStore").onclick = async () => {
      const button = $("saveEasyOrdersStore");
      button.disabled = true;
      try {
        const countryCode = $("easyOrdersCountry").value;
        if (!countryCode) throw new Error("اختر دولة متجر EasyOrders أولاً.");
        const storeUrl = $("easyOrdersStoreUrl").value.trim();
        const { data, error } = await db.functions.invoke("easyorders-catalog-sync", {
          body: { mode: "configure_store", country_code: countryCode, store_url: storeUrl || null }
        });
        if (error) throw error;
        if (!data?.success) throw new Error(data?.error || "تعذر حفظ الإعدادات.");
        storeStatus.textContent = "تم حفظ الدولة " + data.country_code + " والعملة " + data.currency_code + ". حالة الاتصال: " + (data.status || "غير محددة");
        $("integrationTable").innerHTML = '<div class="line"><span>EasyOrders — ' + escapeHTML(data.country_code) + '</span><b>' + escapeHTML(data.status || "غير محددة") + '</b></div><p class="muted">Taager متصلة عبر EasyOrders.</p>';
        notify("تم حفظ إعدادات متجر EasyOrders.");
      } catch (error) {
        storeStatus.textContent = error.message;
        notify(error.message);
      } finally {
        button.disabled = false;
      }
    };

    $("openEasyOrdersStore").onclick = () => {
      const url = $("easyOrdersStoreUrl").value.trim();
      if (!url) {
        notify("أدخل رابط متجر EasyOrders ثم احفظه أولاً.");
        return;
      }
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") throw new Error();
        window.open(parsed.href, "_blank", "noopener,noreferrer");
      } catch {
        notify("رابط المتجر غير صحيح. استخدم رابط HTTPS.");
      }
    };

    $("readiness").onclick = async () => {
      const button = $("readiness");
      button.disabled = true;

      try {
        const result = await invokeControl("readiness");

        notify(
          result.ready
            ? "الفحوص الأساسية ناجحة."
            : "المتطلبات الناقصة: " +
              (result.blockers || []).join("، ")
        );
      } catch (error) {
        notify(error.message);
      } finally {
        button.disabled = false;
      }
    };
  }

  // =========================================
  // الأرباح
  // =========================================

  async function renderProfit() {
    const {data: orders, error} = await db.from("orders")
      .select("order_number,status,currency_code,subtotal,shipping_amount,discount_amount,total_amount,supplier_cost,ad_cost,other_cost,created_at")
      .order("created_at",{ascending:false}).limit(1000);
    if (error) throw error;
    const rows = orders || [];
    const groups = new Map();
    for (const order of rows) {
      const currency = String(order.currency_code || "غير محددة").toUpperCase();
      if (!groups.has(currency)) groups.set(currency, {
        currency, count: 0, delivered: 0, sales: 0, supplier: 0,
        shipping: 0, adsEGP: 0, other: 0, discounts: 0,
        missingSupplierCost: 0, statuses: {}
      });
      const g = groups.get(currency);
      g.count++;
      g.statuses[order.status] = (g.statuses[order.status] || 0) + 1;
      if (order.status === "delivered") g.delivered++;
      g.sales += Number(order.subtotal || 0);
      g.supplier += Number(order.supplier_cost || 0);
      g.shipping += Number(order.shipping_amount || 0);
      g.discounts += Number(order.discount_amount || 0);
      g.other += Number(order.other_cost || 0);
      // Advertising spend is stored in EGP and is not mixed into foreign currencies.
      g.adsEGP += Number(order.ad_cost || 0);
      if (Number(order.supplier_cost || 0) <= 0) g.missingSupplierCost++;
    }
    const fmt = (v, currency) => new Intl.NumberFormat("ar-EG",{maximumFractionDigits:2}).format(v) + " " + currency;
    const cards = [...groups.values()].map(g => {
      const estimated = g.sales - g.supplier - g.shipping - g.discounts - g.other;
      return `<div class="panel">
        <h3>السوق بعملة ${escapeHTML(g.currency)}</h3>
        <div class="grid">
          <div><small>عدد الطلبات</small><b>${g.count}</b></div>
          <div><small>طلبات تم تسليمها</small><b>${g.delivered}</b></div>
          <div><small>قيمة المنتجات المسجلة</small><b>${fmt(g.sales,g.currency)}</b></div>
          <div><small>تكلفة المورد المسجلة</small><b>${fmt(g.supplier,g.currency)}</b></div>
          <div><small>الشحن المسجل</small><b>${fmt(g.shipping,g.currency)}</b></div>
          <div><small>الخصومات</small><b>${fmt(g.discounts,g.currency)}</b></div>
          <div><small>المصروفات الأخرى</small><b>${fmt(g.other,g.currency)}</b></div>
          <div><small>إعلانات مسجلة بالجنيه المصري</small><b>${fmt(g.adsEGP,"EGP")}</b></div>
        </div>
        <p class="muted">هامش تقديري قبل تكلفة الإعلانات والتحقق من التحصيل: ${fmt(estimated,g.currency)}</p>
        <p class="muted">${g.missingSupplierCost ? `تنبيه: ${g.missingSupplierCost} طلب/طلبات بدون تكلفة مورد مسجلة؛ النتيجة ليست صافي ربح.` : "تكاليف المورد مسجلة، لكن يجب مطابقة التحصيل والمرتجعات قبل اعتماد الربح المحقق."}</p>
        <p class="muted">توزيع الحالات: ${escapeHTML(Object.entries(g.statuses).map(([k,v]) => k + ": " + v).join(" • "))}</p>
      </div>`;
    }).join("");
    $("view").innerHTML = `
      <div class="head"><div><h1>${pages.profit}</h1>
      <p class="muted">تحليل منفصل لكل عملة سوق. لا يتم جمع عملات مختلفة في إجمالي واحد ولا اعتبار التقديرات أرباحًا محققة.</p></div></div>
      <div class="notice">تنبيه مالي: صافي الربح لا يمكن اعتماده قبل تسجيل تكلفة Taager الفعلية، والتحصيل، والمرتجعات، ومصروفات الإعلان. جميع مصروفات الإعلانات تُراجع بالجنيه المصري.</div>
      ${cards || '<div class="panel"><p class="muted">لا توجد طلبات مالية مسجلة بعد.</p></div>'}
      <div class="panel"><h3>تفاصيل الطلبات</h3><div id="profitTable"></div></div>`;
    renderTable($("profitTable"), rows);
  }

  // =========================================
  // الطلبات - متابعة الطلبات وبنودها
  // =========================================
  async function renderOrders() {
    const [{data: orders, error: ordersError}, {data: items, error: itemsError}] = await Promise.all([
      db.from("orders").select("id,order_number,external_order_id,source_channel,status,currency_code,subtotal,shipping_amount,discount_amount,total_amount,supplier_cost,ad_cost,other_cost,tracking_number,shipping_provider,created_at,updated_at").order("created_at",{ascending:false}).limit(200),
      db.from("order_items").select("order_id,product_name,sku,quantity,unit_price,unit_cost,line_total").limit(1000)
    ]);
    if (ordersError) throw ordersError;
    if (itemsError) throw itemsError;
    const rows = orders || [];
    const grouped = new Map();
    (items || []).forEach(item => {
      if (!grouped.has(item.order_id)) grouped.set(item.order_id, []);
      grouped.get(item.order_id).push(item);
    });
    const view = $("view");
    view.innerHTML = `
      <div class="head"><div><h1>${pages.orders}</h1>
      <p class="muted">متابعة الطلبات الواردة من EasyOrders وغيرها، مع تفاصيل المنتجات والشحن والتكاليف المسجلة.</p></div>
      <span class="badge">الطلبات: ${rows.length}</span></div>
      <div class="panel">
        <label for="orderSearch"><b>بحث برقم الطلب أو رقم الطلب الخارجي أو الحالة</b></label>
        <input id="orderSearch" type="search" placeholder="اكتب رقم الطلب أو الحالة" style="display:block;width:100%;max-width:520px;margin-top:8px;padding:12px;border:1px solid #d8deea;border-radius:10px">
        <p class="muted">يتم عرض الحالة كما وصلت من النظام المصدر. لا يتم تغيير حالة الشحن أو التسليم دون تحديث موثوق من مزود الخدمة.</p>
      </div>
      <div id="orderRows"></div>`;
    const target = $("orderRows");
    const money = (v, currency) => v == null ? "—" : new Intl.NumberFormat("ar-EG",{maximumFractionDigits:2}).format(Number(v)) + " " + (currency || "");
    const draw = (query = "") => {
      const q = query.trim().toLowerCase();
      const filtered = rows.filter(o => [o.order_number,o.external_order_id,o.status,o.source_channel]
        .some(v => String(v || "").toLowerCase().includes(q)));
      if (!filtered.length) {
        target.innerHTML = '<div class="panel"><p class="muted">لا توجد طلبات مطابقة.</p></div>';
        return;
      }
      target.innerHTML = filtered.map(o => {
        const orderItems = grouped.get(o.id) || [];
        return `<div class="panel" style="overflow:auto">
          <div class="head"><div><h3>${escapeHTML(o.order_number)}</h3>
          <p class="muted">المصدر: ${escapeHTML(o.source_channel)} • الرقم الخارجي: ${escapeHTML(o.external_order_id || "—")}</p></div>
          <b>${escapeHTML(o.status)}</b></div>
          <table><tbody>
            <tr><th>المنتجات</th><th>SKU</th><th>الكمية</th><th>سعر الوحدة</th><th>تكلفة الوحدة</th><th>الإجمالي</th></tr>
            ${orderItems.length ? orderItems.map(i => `<tr><td>${escapeHTML(i.product_name)}</td><td>${escapeHTML(i.sku || "—")}</td><td>${i.quantity}</td><td>${money(i.unit_price,o.currency_code)}</td><td>${money(i.unit_cost,o.currency_code)}</td><td>${money(i.line_total,o.currency_code)}</td></tr>`).join("") : '<tr><td colspan="6">لم تصل تفاصيل المنتجات لهذا الطلب.</td></tr>'}
          </tbody></table>
          <div class="grid" style="margin-top:12px">
            <div><small>قيمة المنتجات</small><b>${money(o.subtotal,o.currency_code)}</b></div>
            <div><small>الشحن</small><b>${money(o.shipping_amount,o.currency_code)}</b></div>
            <div><small>الخصم</small><b>${money(o.discount_amount,o.currency_code)}</b></div>
            <div><small>الإجمالي</small><b>${money(o.total_amount,o.currency_code)}</b></div>
            <div><small>تكلفة المورد المسجلة</small><b>${money(o.supplier_cost,o.currency_code)}</b></div>
            <div><small>تكلفة الإعلان المسجلة</small><b>${money(o.ad_cost,"EGP")}</b></div>
          </div>
          <p class="muted">شركة الشحن: ${escapeHTML(o.shipping_provider || "غير محددة")} • رقم التتبع: ${escapeHTML(o.tracking_number || "غير مسجل")} • تاريخ الإنشاء: ${escapeHTML(o.created_at || "—")}</p>
        </div>`;
      }).join("");
    };
    $("orderSearch").addEventListener("input", e => draw(e.target.value));
    draw();
  }

  // =========================================
  // الأقسام الأخرى
  // =========================================

  async function renderSection(page) {
    const table = tables[page];

    if (!table) {
      $("view").innerHTML = `
        <div class="panel">
          <h3>${escapeHTML(pages[page] || page)}</h3>

          <p class="muted">
            هذا القسم يحتاج استكمال إعداداته قبل تفعيله.
          </p>
        </div>`;

      return;
    }

    const rows = await getRows(table);

    $("view").innerHTML = `
      <h1>${pages[page]}</h1>
      <div id="sectionTable"></div>
    `;

    renderTable($("sectionTable"), rows);
  }

  // =========================================
  // الإعدادات
  // =========================================

  async function renderSettings() {
    $("view").innerHTML = `
      <h1>${pages.settings}</h1>

      <div class="panel">
        <h3>إعدادات الأمان</h3>

        <p class="muted">
          لا تحفظ مفاتيح API السرية في ملفات الواجهة.
        </p>

        <p class="muted">
          مفاتيح الخدمة تحفظ في Supabase Secrets فقط.
        </p>

        <p class="muted">
          أي حملة إعلانية أو إنفاق مالي يحتاج موافقة صريحة.
        </p>
      </div>
    `;
  }

  // =========================================
  // التنقل بين الصفحات
  // =========================================

  async function render(page) {
    if (!pages[page]) {
      page = "overview";
    }

    currentPage = page;

    // إغلاق القائمة قبل تحميل القسم
    closeSidebar();

    $("title").textContent = pages[page];

    document.querySelectorAll("nav button").forEach(button => {
      button.classList.toggle(
        "active",
        button.dataset.page === page
      );
    });

    const view = $("view");

    view.innerHTML = `
      <div class="panel">
        جارٍ تحميل القسم...
      </div>`;

    try {
      if (page === "orders") {
        await renderOrders();
      } else if (page === "products") {
        await renderProducts();
      } else if (page === "campaigns") {
        await renderCampaigns();
      } else if (page === "overview") {
        await renderOverview();
      } else if (page === "markets") {
        await renderMarkets();
      } else if (page === "integrations") {
        await renderIntegrations();
      } else if (page === "profit") {
        await renderProfit();
      } else if (page === "settings") {
        await renderSettings();
      } else {
        await renderSection(page);
      }
    } catch (error) {
      showError(view, error.message);
    }
  }

  // =========================================
  // التحقق من المستخدم
  // =========================================

  async function boot() {
    const {
      data: { session },
      error
    } = await db.auth.getSession();

    if (error) throw error;

    if (!session) {
      $("login").hidden = false;
      $("app").hidden = true;
      return;
    }

    const {
      data: profile,
      error: profileError
    } = await db
      .from("profiles")
      .select("role,is_active")
      .eq("id", session.user.id)
      .maybeSingle();

    if (profileError) throw profileError;

    if (
      !profile ||
      profile.is_active !== true ||
      !["owner", "admin"].includes(profile.role)
    ) {
      await db.auth.signOut();

      $("msg").textContent =
        "هذا الحساب غير مصرح له بالدخول.";

      return;
    }

    currentUser = session.user;

    $("login").hidden = true;
    $("app").hidden = false;

    // تجهيز القائمة بعد ظهور التطبيق
    setupSidebar();

    await render("overview");
  }

  // =========================================
  // تسجيل الدخول
  // =========================================

  async function handleLogin(event) {
    if (event) {
      event.preventDefault();
    }

    if (loginInProgress) return;

    loginInProgress = true;

    const button = $("loginBtn");

    if (button) {
      button.disabled = true;
    }

    $("msg").textContent = "";

    try {
      const email = $("email").value.trim();
      const password = $("password").value;

      if (!email || !password) {
        throw new Error(
          "اكتب البريد الإلكتروني وكلمة المرور."
        );
      }

      const { error } = await db.auth.signInWithPassword({
        email,
        password
      });

      if (error) throw error;

      await boot();

    } catch (error) {
      $("msg").textContent = error.message;

    } finally {
      loginInProgress = false;

      if (button) {
        button.disabled = false;
      }
    }
  }

  // =========================================
  // تشغيل التطبيق
  // =========================================

  async function startApp() {
    if (
      !cfg.SUPABASE_URL ||
      !cfg.SUPABASE_ANON_KEY ||
      !window.supabase
    ) {
      $("msg").textContent =
        "إعداد الاتصال غير مكتمل. راجع ملف web/config.js.";

      return;
    }

    db = window.supabase.createClient(
      cfg.SUPABASE_URL,
      cfg.SUPABASE_ANON_KEY
    );

    // نموذج تسجيل الدخول
    const loginForm = $("loginForm");

    if (loginForm) {
      loginForm.addEventListener(
        "submit",
        handleLogin
      );
    } else if ($("loginBtn")) {
      $("loginBtn").onclick = handleLogin;
    }

    // تسجيل الخروج
    if ($("logout")) {
      $("logout").onclick = async () => {
        try {
          await db.auth.signOut();
          location.reload();
        } catch (error) {
          notify(error.message);
        }
      };
    }

    // أزرار التنقل
    document.querySelectorAll("nav button[data-page]").forEach(button => {
      button.onclick = (event) => {
        event.preventDefault();

        const page = button.dataset.page;

        // الإغلاق فورًا قبل تحميل القسم
        closeSidebar();

        render(page);
      };
    });

    db.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        currentUser = null;
        closeSidebar();

        $("login").hidden = false;
        $("app").hidden = true;
      }
    });

    await boot();
  }

  startApp().catch(error => {
    const message =
      "حدث خطأ أثناء تشغيل المنصة: " + error.message;

    if ($("msg")) {
      $("msg").textContent = message;
    } else {
      notify(message);
    }
  });

})();
