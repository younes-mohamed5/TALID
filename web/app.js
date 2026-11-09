
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
      if (page === "overview") {
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
