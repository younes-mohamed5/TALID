
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
      : "المنصة متوقفة وفي وضع المراجعة.";

    view.innerHTML = `
      <div class="head">
        <div>
          <h1>مرحبًا بك في TALID</h1>
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
            Taager مسؤولة عن تنفيذ البيع والشحن والتحصيل
            وفق إمكانات حسابك.
          </p>

          <p class="muted">
            EasyOrders مسؤولة عن صفحات الهبوط واستقبال الطلبات
            وفق إعدادات التكامل.
          </p>

          <p class="muted">
            TALID تتابع البيانات وتحلل النتائج.
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
    const rows = await db.from("products")
      .select("id,sku,supplier_sku,supplier_product_id,name_ar,name_en,supplier_name,cost_price,sale_price,currency_code,stock_status,status,updated_at")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (rows.error) throw rows.error;
    const products = rows.data || [];
    const view = $("view");
    view.innerHTML = `
      <div class="head">
        <div><h1>${pages.products}</h1>
        <p class="muted">عرض كتالوج المنتجات المحفوظ حاليًا في قاعدة البيانات، مع كود المورد والتكلفة والسعر.</p></div>
        <span class="badge">عدد المنتجات: ${products.length}</span>
      </div>
      <div class="panel">
        <label for="productSearch"><b>بحث بالاسم أو SKU / Taager Code</b></label>
        <input id="productSearch" type="search" placeholder="اكتب اسم المنتج أو الكود" style="display:block;width:100%;max-width:520px;margin-top:8px;padding:12px;border:1px solid #d8deea;border-radius:10px">
        <p class="muted">استيراد Taager المباشر غير مفعل حتى يتم توثيق واجهة الربط الرسمية. لن نضيف منتجات وهمية أو نعتبر بيانات المتجر مستوردة.</p>
      </div>
      <div id="productRows"></div>`;
    const target = $("productRows");
    const draw = (query = "") => {
      const q = query.trim().toLowerCase();
      const filtered = products.filter(p => [p.name_ar,p.name_en,p.sku,p.supplier_sku,p.supplier_product_id]
        .some(v => String(v || "").toLowerCase().includes(q)));
      if (!filtered.length) {
        target.innerHTML = '<div class="panel"><p class="muted">لا توجد منتجات مطابقة. إذا كان الكتالوج فارغًا، فهذا يعني أن مزامنة Taager لم تُنفذ بعد.</p></div>';
        return;
      }
      const fmt = v => v == null ? "غير مسجل" : new Intl.NumberFormat("ar-EG",{maximumFractionDigits:2}).format(Number(v));
      target.innerHTML = `<div class="panel" style="overflow:auto"><table>
        <thead><tr><th>المنتج</th><th>SKU</th><th>كود المورد</th><th>المورد</th><th>التكلفة</th><th>السعر</th><th>العملة</th><th>المخزون</th><th>الحالة</th></tr></thead>
        <tbody>${filtered.map(p => `<tr>
          <td>${escapeHTML(p.name_ar || p.name_en || "بدون اسم")}</td>
          <td>${escapeHTML(p.sku || "غير مسجل")}</td>
          <td>${escapeHTML(p.supplier_sku || p.supplier_product_id || "غير مسجل")}</td>
          <td>${escapeHTML(p.supplier_name || "غير محدد")}</td>
          <td>${fmt(p.cost_price)}</td><td>${fmt(p.sale_price)}</td>
          <td>${escapeHTML(p.currency_code || "غير محددة")}</td>
          <td>${escapeHTML(p.stock_status || "غير محدد")}</td>
          <td>${escapeHTML(p.status || "غير محدد")}</td>
        </tr>`).join("")}</tbody></table></div>`;
    };
    $("productSearch").addEventListener("input", e => draw(e.target.value));
    draw();
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
      <p class="muted">إنشاء مسودات الحملات ومراجعة ميزانياتها. جميع ميزانيات ومصروفات الحملات تُسجل بالجنيه المصري (EGP).</p></div>
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
          <label for="campaignBudget">الميزانية بالجنيه المصري (EGP)</label>
          <input id="campaignBudget" type="number" min="0" step="0.01" required placeholder="0.00">
          <button id="saveCampaign" type="submit">حفظ كمسودة</button>
        </form>
        <p class="muted">حفظ المسودة لا ينشئ إعلانًا ولا يربط بطاقة دفع ولا ينفق أي أموال.</p>
      </div>
      <div class="panel"><h3>الحملات المسجلة</h3><div id="campaignRows"></div></div>`;
    $("campaignForm").addEventListener("submit", async event => {
      event.preventDefault();
      const button = $("saveCampaign");
      button.disabled = true;
      try {
        const budget = Number($("campaignBudget").value);
        if (!Number.isFinite(budget) || budget < 0) throw new Error("أدخل ميزانية صحيحة بالجنيه المصري.");
        const {error} = await db.from("marketing_campaigns").insert({
          name: $("campaignName").value.trim(),
          platform: $("campaignPlatform").value,
          country_id: $("campaignCountry").value,
          status: "draft",
          budget,
          currency_code: "EGP",
          content: {approval_required: true, publishing_enabled: false}
        });
        if (error) throw error;
        notify("تم حفظ الحملة كمسودة بالجنيه المصري. لم يتم نشر إعلان.");
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
    const fmt = v => v == null ? "غير محددة" : new Intl.NumberFormat("ar-EG",{style:"currency",currency:"EGP"}).format(Number(v));
    target.innerHTML = `<div style="overflow:auto"><table>
      <thead><tr><th>الحملة</th><th>المنصة</th><th>السوق</th><th>الميزانية</th><th>العملة</th><th>الحالة</th><th>الإجراء</th></tr></thead>
      <tbody>${campaigns.map(c => `<tr>
        <td>${escapeHTML(c.name)}</td><td>${escapeHTML(c.platform)}</td>
        <td>${escapeHTML(countryMap.get(c.country_id)?.name_ar || "غير محدد")}</td>
        <td>${fmt(c.budget)}</td><td>${escapeHTML(c.currency_code || "غير مسجلة")}</td>
        <td>${escapeHTML(c.status)}</td>
        <td>${["draft","pending_approval","paused"].includes(c.status) ? `<button type="button" data-campaign-id="${escapeHTML(c.id)}" data-next-status="draft">إبقاء كمسودة</button>` : "لا يوجد إجراء آمن"}</td>
      </tr>`).join("")}</tbody></table></div>
      <p class="muted">الحملات القديمة التي لا تحمل العملة EGP تظهر كما هي للمراجعة ولا يتم تحويلها تلقائيًا.</p>`;
    target.querySelectorAll("button[data-campaign-id]").forEach(button => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const {error} = await db.from("marketing_campaigns")
            .update({status:"draft",currency_code:"EGP"})
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
    const [
      integrations,
      webhookCount
    ] = await Promise.all([
      getRows("talid_integrations"),
      getCount("talid_webhook_events")
    ]);

    $("view").innerHTML = `
      <div class="head">
        <h1>${pages.integrations}</h1>
        <button id="readiness">فحص الجاهزية</button>
      </div>

      <div class="panel">
        <h3>حالة التكاملات</h3>

        <div id="integrationTable"></div>

        <p class="muted">
          عدد أحداث Webhook المستلمة:
          ${webhookCount}
        </p>

        <p class="muted">
          لا يتم اعتبار أي تكامل نشطًا قبل اختبار الاتصال
          والتحقق من الصلاحيات والبيانات الفعلية.
        </p>
      </div>
    `;

    renderTable($("integrationTable"), integrations);

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
    const rows = await getRows("orders");

    $("view").innerHTML = `
      <h1>${pages.profit}</h1>

      <div class="panel">
        <p class="muted">
          هذه صفحة مراجعة الطلبات المالية.
          لن نحسب صافي الربح قبل التأكد من أعمدة
          التكلفة والشحن والإعلان والتحصيل والمرتجعات.
        </p>

        <div id="profitTable"></div>
      </div>
    `;

    renderTable($("profitTable"), rows);
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
      if (page === "products") {
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
