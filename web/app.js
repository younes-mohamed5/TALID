
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const cfg = window.TALID_CONFIG || {};

  let db = null;
  let currentPage = "overview";
  let currentUser = null;

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

  // الجداول الأساسية الموجودة في قاعدة البيانات الأصلية
  const tables = {
    products: "products",
    orders: "orders",
    markets: "talid_markets",
    campaigns: "marketing_campaigns",
    activity: "talid_audit_logs"
  };

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
    toast.style.display = "block";

    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => {
      toast.style.display = "none";
    }, 4000);
  }

  function showError(container, message) {
    container.innerHTML = `
      <div class="panel">
        <h3>تعذر تحميل البيانات</h3>
        <p class="muted">${escapeHTML(message)}</p>
      </div>`;
  }

  async function invokeControl(action) {
    const {
      data: { session },
      error: sessionError
    } = await db.auth.getSession();

    if (sessionError) throw sessionError;
    if (!session) throw new Error("انتهت جلسة الدخول. سجل الدخول مرة أخرى.");

    const { data, error } = await db.functions.invoke(
      "talid-control",
      { body: { action } }
    );

    if (error) {
      let details = error.message || "تعذر الاتصال بدالة التشغيل";

      if (error.context && typeof error.context.json === "function") {
        try {
          const body = await error.context.json();
          details = body.blockers?.join("، ") ||
            body.error ||
            body.message ||
            details;
        } catch (_) {}
      }

      throw new Error(details);
    }

    if (data?.error) throw new Error(data.error);

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
      .select("*", { count: "exact", head: true });

    if (error) throw error;

    return count || 0;
  }

  function renderTable(container, rows) {
    if (!rows.length) {
      container.innerHTML = `
        <div class="panel">
          <p class="muted">لا توجد بيانات مسجلة حتى الآن.</p>
        </div>`;
      return;
    }

    const columns = Object.keys(rows[0]);

    container.innerHTML = `
      <div class="panel" style="overflow:auto">
        <table>
          <thead>
            <tr>
              ${columns.map(col =>
                `<th>${escapeHTML(col)}</th>`
              ).join("")}
            </tr>
          </thead>
          <tbody>
            ${rows.map(row => `
              <tr>
                ${columns.map(col => {
                  const value = row[col];
                  const display =
                    value && typeof value === "object"
                      ? JSON.stringify(value)
                      : value;

                  return `<td>${escapeHTML(display)}</td>`;
                }).join("")}
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>`;
  }

  async function renderOverview() {
    const view = $("view");

    view.innerHTML = `
      <div class="panel">جارٍ فحص حالة المنصة وتحميل البيانات...</div>`;

    const [ordersCount, productsCount, markets, runtime] =
      await Promise.all([
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
          <div class="num">${isRunning ? "نشطة" : "متوقفة"}</div>
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
              : `<p class="muted">لم تتم إضافة الدول بعد.</p>`
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

  async function renderMarkets() {
    const rows = await getRows("talid_markets");
    const view = $("view");

    view.innerHTML = `
      <h1>${pages.markets}</h1>
      <div class="panel">
        <p class="muted">
          بيانات الدول الحالية حسب أعمدة قاعدة البيانات الموجودة.
        </p>
        <div id="marketTable"></div>
      </div>
    `;

    renderTable($("marketTable"), rows);
  }

  async function renderIntegrations() {
    const [integrations, webhookCount] = await Promise.all([
      getRows("talid_integrations"),
      getCount("talid_webhook_events")
    ]);

    const view = $("view");

    view.innerHTML = `
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
      }
    };
  }

  async function renderProfit() {
    const rows = await getRows("orders");

    const view = $("view");

    view.innerHTML = `
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

  async function renderSection(page) {
    const table = tables[page];

    if (!table) {
      $("view").innerHTML = `
        <div class="panel">
          <h3>${pages[page]}</h3>
          <p class="muted">
            هذا القسم يحتاج استكمال إعداداته قبل تفعيله.
          </p>
        </div>`;
      return;
    }

    const rows = await getRows(table);
    const view = $("view");

    view.innerHTML = `
      <h1>${pages[page]}</h1>
      <div id="sectionTable"></div>
    `;

    renderTable($("sectionTable"), rows);
  }

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

  async function render(page) {
    currentPage = page;

    $("title").textContent = pages[page];

    document.querySelectorAll("nav button").forEach(button => {
      button.classList.toggle(
        "active",
        button.dataset.page === page
      );
    });

    const view = $("view");
    view.innerHTML = `
      <div class="panel">جارٍ تحميل القسم...</div>`;

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

    const { data: profile, error: profileError } = await db
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
      $("msg").textContent = "هذا الحساب غير مصرح له بالدخول.";
      return;
    }

    currentUser = session.user;

    $("login").hidden = true;
    $("app").hidden = false;

    await render("overview");
  }

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

    $("loginBtn").onclick = async () => {
      $("loginBtn").disabled = true;

      try {
        const { error } = await db.auth.signInWithPassword({
          email: $("email").value.trim(),
          password: $("password").value
        });

        if (error) throw error;

        await boot();
      } catch (error) {
        $("msg").textContent = error.message;
      } finally {
        $("loginBtn").disabled = false;
      }
    };

    $("logout").onclick = async () => {
      await db.auth.signOut();
      location.reload();
    };

    document.querySelectorAll("nav button").forEach(button => {
      button.onclick = () => render(button.dataset.page);
    });

    $("menu").onclick = () => {
      $("app").querySelector("aside").classList.toggle("open");
    };

    db.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        $("login").hidden = false;
        $("app").hidden = true;
      }
    });

    await boot();
  }

  startApp().catch(error => {
    $("msg").textContent =
      "حدث خطأ أثناء تشغيل المنصة: " + error.message;
  });

})();
