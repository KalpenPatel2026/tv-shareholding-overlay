/*
 * TV Shareholding Overlay — content script.
 *
 * Injects a floating panel on TradingView chart pages showing promoter holding,
 * pledge %, and RPT/Sales (latest + history). Auto-detects the active symbol
 * from the page title / URL and re-renders when it changes.
 *
 * Data source priority:
 *   1. http://127.0.0.1:8765/data.json   (local server, live - updated nightly)
 *   2. chrome-extension://.../data.json  (bundled fallback if server is down)
 */

(() => {
  if (window.__tvsoLoaded) return;
  window.__tvsoLoaded = true;
  const VERSION = "0.4.0";
  console.log(`[TVSO] content script loaded v${VERSION} on ${location.href}`);

  // Default fetch chain: localhost (dev) → GitHub raw (cloud) → bundled (last resort)
  const DEFAULT_DATA_SOURCES = [
    "http://127.0.0.1:8765/data.json",
    "https://raw.githubusercontent.com/KalpenPatel2026/tv-shareholding-overlay/main/extension/data.json",
  ];
  const BUNDLED_URL = chrome.runtime.getURL("data.json");
  const STORAGE_KEY = "tvso_settings_v1";

  let DATA = null;
  let dataSource = "none";
  let currentSlug = null;

  // Settings (persisted) — defaults
  const DEFAULT_SETTINGS = {
    mode: "fy",
    periods: 10,
    x: null,
    y: null,
    collapsed: false,
    asOf: null,
    delta: "off",
    // Cosmetic
    width: 360,
    fontSize: 13,
    opacity: 97,
    panelBg: "#1e222d",
    textColor: "#d1d4dc",
    colorGood: "#26a69a",
    colorWarn: "#ffb74d",
    colorBad: "#ef5350",
    colorNa: "#5d606b",
    // Thresholds (percent)
    promGood: 50,    // >= = good
    promWarn: 25,    // >= = warn (else bad)
    pledgeGood: 5,   // <= = good
    pledgeWarn: 25,  // <= = warn (else bad)
    rptGood: 5,
    rptWarn: 10,
    settingsOpen: false,
  };
  let settings = Object.assign({}, DEFAULT_SETTINGS);

  /* ============================================================
   * Data loading
   * ============================================================ */
  async function loadData() {
    const sources = (settings.dataSources && settings.dataSources.length)
      ? settings.dataSources
      : DEFAULT_DATA_SOURCES;
    for (const url of sources) {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.ok) {
          DATA = await r.json();
          dataSource = url.startsWith("http://127.") ? "local"
            : url.includes("raw.githubusercontent") ? "cloud"
            : "remote";
          console.log(`[TVSO] loaded from ${dataSource} (${url})`);
          return;
        }
      } catch (_) { /* try next */ }
    }
    try {
      const r = await fetch(BUNDLED_URL);
      if (r.ok) {
        DATA = await r.json();
        dataSource = "bundled";
        return;
      }
    } catch (_) {}
    DATA = { stocks: {}, by_tv: {}, as_of: null };
    dataSource = "none";
  }

  /* ============================================================
   * Symbol detection
   * ============================================================ */
  function readCurrentSymbol() {
    // 1. DOM legend on chart - most reliable for SPA navigation.
    //    TV's chart header element with the ticker symbol button.
    try {
      const legend = document.querySelector(
        '[data-name="legend-source-title"], button[class*="mainSymbol"], div[class*="mainTitle"]'
      );
      if (legend) {
        const text = legend.textContent || legend.innerText || "";
        const m = text.match(/\b([A-Z]+):([A-Z0-9_\-&]+)\b/);
        if (m) return `${m[1]}:${m[2]}`;
      }
    } catch (_) {}

    // 2. document.title — TV updates this when symbol changes inside SPA
    const t1 = document.title.match(/\b(NSE|BSE|MCX|NCDEX|NASDAQ|NYSE|LSE|HKEX|FX|FOREX|CRYPTO|BINANCE)[:\s]+([A-Z0-9_\-&]+)/);
    if (t1) return `${t1[1]}:${t1[2]}`;
    const t2 = document.title.match(/^([A-Z]+):([A-Z0-9_\-&]+)/);
    if (t2) return `${t2[1]}:${t2[2]}`;

    // 3. URL ?symbol= param — only reliable on full page load
    try {
      const u = new URL(window.location.href);
      const s = u.searchParams.get("symbol");
      if (s) return decodeURIComponent(s).toUpperCase();
    } catch (_) {}

    // 4. /symbols/EXCHANGE-TICKER/ path
    const m = window.location.pathname.match(/\/symbols\/([A-Z]+)-([A-Z0-9_\-&]+)/i);
    if (m) return `${m[1].toUpperCase()}:${m[2].toUpperCase()}`;

    return null;
  }

  function lookupTV(sym) {
    if (!DATA || !sym) return null;
    if (DATA.by_tv && DATA.by_tv[sym]) return DATA.by_tv[sym];
    // Fallback: drop exchange prefix and try slug match
    const tail = sym.split(":").pop();
    if (DATA.stocks && DATA.stocks[tail]) return tail;
    return null;
  }

  /* ============================================================
   * Color thresholds
   * ============================================================ */
  function clsProm(v) {
    if (v == null) return "tvso-na";
    if (v >= settings.promGood) return "tvso-good";
    if (v >= settings.promWarn) return "tvso-warn";
    return "tvso-bad";
  }
  function clsPledge(v) {
    if (v == null) return "tvso-na";
    if (v <= settings.pledgeGood) return "tvso-good";
    if (v <= settings.pledgeWarn) return "tvso-warn";
    return "tvso-bad";
  }
  function clsRpt(v) {
    if (v == null) return "tvso-na";
    if (v <= settings.rptGood) return "tvso-good";
    if (v <= settings.rptWarn) return "tvso-warn";
    return "tvso-bad";
  }
  function fmt(v) { return v == null ? "N/A" : v.toFixed(2) + "%"; }

  /* ============================================================
   * Period parsing — convert "Mar 2025", "FY25", "Sep 2024" to Date
   * Returns Date object representing END of period (last day).
   * ============================================================ */
  const MON = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  function periodToDate(p) {
    if (!p) return null;
    const s = String(p).trim();
    // FYxx form (Indian fiscal year ending March)
    let m = s.match(/^FY(\d{2,4})$/i);
    if (m) {
      let y = parseInt(m[1], 10);
      if (y < 100) y += 2000;
      return new Date(y, 2, 31);   // 31-Mar of FYxx
    }
    // "Mar 2025" / "Sep 2024" form
    m = s.match(/^([A-Za-z]{3})\s+(\d{4})$/);
    if (m) {
      const mo = MON[m[1].toLowerCase()];
      const y = parseInt(m[2], 10);
      if (mo == null) return null;
      // last day of month
      return new Date(y, mo + 1, 0);
    }
    // "01-04-2020" style
    m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    // ISO yyyy-mm-dd
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    return null;
  }

  function filterByAsOf(series, asOfDateStr) {
    if (!asOfDateStr) return series;
    const cutoff = new Date(asOfDateStr);
    if (isNaN(cutoff)) return series;
    return series.filter(pt => {
      const d = periodToDate(pt.p);
      return d && d <= cutoff;
    });
  }

  function findCompareValue(series, anchorPeriod, deltaMode) {
    if (deltaMode === "off" || !anchorPeriod) return null;
    const anchorDate = periodToDate(anchorPeriod);
    if (!anchorDate) return null;
    let monthsBack;
    if (deltaMode === "1q") monthsBack = 3;
    else if (deltaMode === "1y") monthsBack = 12;
    else if (deltaMode === "3y") monthsBack = 36;
    else return null;
    const target = new Date(anchorDate);
    target.setMonth(target.getMonth() - monthsBack);
    // Find period whose date is closest to target (within +/- 60 days), preferring on-or-before
    let best = null, bestDiff = Infinity;
    for (const pt of series) {
      const d = periodToDate(pt.p);
      if (!d) continue;
      const diff = Math.abs(d - target);
      if (diff < bestDiff && diff < 75 * 86400 * 1000) {
        bestDiff = diff;
        best = pt;
      }
    }
    return best;
  }
  function fmtDelta(d) {
    if (d == null || isNaN(d)) return "—";
    const sign = d > 0 ? "▲" : (d < 0 ? "▼" : "•");
    return `${sign} ${Math.abs(d).toFixed(2)}`;
  }
  function deltaCls(d) {
    if (d == null || isNaN(d)) return "tvso-na";
    if (d > 0.05) return "tvso-good";
    if (d < -0.05) return "tvso-bad";
    return "tvso-na";
  }

  /* ============================================================
   * Panel construction
   * ============================================================ */
  function buildPanel() {
    const p = document.createElement("div");
    p.className = "tvso-panel";
    p.innerHTML = `
      <div class="tvso-header">
        <span class="tvso-title">Shareholding · History</span>
        <div class="tvso-controls">
          <span data-act="refresh" title="Refresh data">&#8635;</span>
          <span data-act="settings" title="Settings">&#9881;</span>
          <span data-act="collapse" title="Collapse / expand">&minus;</span>
          <span data-act="reset-pos" title="Reset position to top-right">&#8689;</span>
        </div>
      </div>
      <div class="tvso-settings" hidden>
        <div class="tvso-set-row">
          <label>Width</label>
          <input type="range" min="260" max="600" data-set="width">
          <span data-set-val="width">—</span>px
        </div>
        <div class="tvso-set-row">
          <label>Text size</label>
          <input type="range" min="10" max="18" data-set="fontSize">
          <span data-set-val="fontSize">—</span>px
        </div>
        <div class="tvso-set-row">
          <label>Opacity</label>
          <input type="range" min="40" max="100" data-set="opacity">
          <span data-set-val="opacity">—</span>%
        </div>
        <div class="tvso-set-row">
          <label>Panel bg</label><input type="color" data-set="panelBg">
          <label>Text</label><input type="color" data-set="textColor">
        </div>
        <div class="tvso-set-row">
          <label>Good</label><input type="color" data-set="colorGood">
          <label>Warn</label><input type="color" data-set="colorWarn">
          <label>Bad</label><input type="color" data-set="colorBad">
        </div>
        <hr class="tvso-set-hr">
        <div class="tvso-set-row tvso-set-thresh">
          <label>Promoter ≥</label>
          <input type="number" min="0" max="100" step="0.5" data-set="promGood" class="tvso-num"> good,
          <input type="number" min="0" max="100" step="0.5" data-set="promWarn" class="tvso-num"> warn
        </div>
        <div class="tvso-set-row tvso-set-thresh">
          <label>Pledge ≤</label>
          <input type="number" min="0" max="100" step="0.5" data-set="pledgeGood" class="tvso-num"> good,
          <input type="number" min="0" max="100" step="0.5" data-set="pledgeWarn" class="tvso-num"> warn
        </div>
        <div class="tvso-set-row tvso-set-thresh">
          <label>RPT/Sales ≤</label>
          <input type="number" min="0" max="100" step="0.5" data-set="rptGood" class="tvso-num"> good,
          <input type="number" min="0" max="100" step="0.5" data-set="rptWarn" class="tvso-num"> warn
        </div>
        <div class="tvso-set-row">
          <button class="tvso-tbtn" data-act="reset-defaults">Reset all to defaults</button>
        </div>
      </div>
      <div class="tvso-body">
        <div class="tvso-ticker">
          <div class="tvso-ticker-name"></div>
          <div class="tvso-ticker-sub"></div>
        </div>
        <div class="tvso-latest">
          <div class="tvso-cell">
            <div class="tvso-clabel">Promoter</div>
            <div class="tvso-cval" data-k="prom">—</div>
            <div class="tvso-cper" data-k="prom-p">—</div>
          </div>
          <div class="tvso-cell">
            <div class="tvso-clabel">Pledge</div>
            <div class="tvso-cval" data-k="ple">—</div>
            <div class="tvso-cper" data-k="ple-p">—</div>
          </div>
          <div class="tvso-cell">
            <div class="tvso-clabel">RPT/Sales</div>
            <div class="tvso-cval" data-k="rpt">—</div>
            <div class="tvso-cper" data-k="rpt-p">—</div>
          </div>
        </div>
        <div class="tvso-controls-bar">
          <div class="tvso-toggle" data-role="mode">
            <button class="tvso-tbtn tvso-active" data-mode="fy">FY</button>
            <button class="tvso-tbtn" data-mode="q">Quarterly</button>
          </div>
          <div class="tvso-slider">
            <label>Periods</label>
            <input type="range" min="3" max="20" value="10">
            <span class="tvso-sval">10</span>
          </div>
        </div>
        <div class="tvso-controls-bar tvso-controls-bar2">
          <div class="tvso-asof">
            <label>As of</label>
            <input type="date" class="tvso-date-input">
            <button class="tvso-tbtn" data-act="asof-clear" title="Reset to latest">×</button>
          </div>
          <div class="tvso-toggle" data-role="delta">
            <span class="tvso-tlabel">Δ:</span>
            <button class="tvso-tbtn tvso-active" data-delta="off">off</button>
            <button class="tvso-tbtn" data-delta="1q">1Q</button>
            <button class="tvso-tbtn" data-delta="1y">1Y</button>
            <button class="tvso-tbtn" data-delta="3y">3Y</button>
          </div>
        </div>
        <div class="tvso-hist">
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Promoter%</th>
                <th>Pledge%</th>
                <th>RPT/Sales%</th>
                <th class="tvso-col-delta" hidden>Δ Prom</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="tvso-foot">
          <span class="tvso-updated">—</span>
          <span class="tvso-status"><span class="tvso-status-dot"></span><span class="tvso-status-text">no data</span></span>
        </div>
      </div>
    `;

    // Apply saved position / collapsed (clamped to viewport)
    if (settings.x != null && settings.y != null) {
      const maxX = Math.max(0, window.innerWidth - 280);
      const maxY = Math.max(0, window.innerHeight - 100);
      const x = Math.min(Math.max(0, settings.x), maxX);
      const y = Math.min(Math.max(0, settings.y), maxY);
      p.style.left = x + "px";
      p.style.top = y + "px";
      p.style.right = "auto";
    }
    if (settings.collapsed) p.classList.add("tvso-collapsed");

    document.body.appendChild(p);
    wirePanel(p);
    applyCosmetics(p);
    syncSettingsInputs(p);
    return p;
  }

  function wirePanel(p) {
    // Drag
    const header = p.querySelector(".tvso-header");
    let drag = false, ox = 0, oy = 0;
    header.addEventListener("mousedown", e => {
      if (e.target.closest(".tvso-controls")) return;
      drag = true;
      ox = e.clientX - p.offsetLeft;
      oy = e.clientY - p.offsetTop;
      e.preventDefault();
    });
    document.addEventListener("mousemove", e => {
      if (!drag) return;
      p.style.left = (e.clientX - ox) + "px";
      p.style.top = (e.clientY - oy) + "px";
      p.style.right = "auto";
    });
    document.addEventListener("mouseup", () => {
      if (!drag) return;
      drag = false;
      settings.x = p.offsetLeft;
      settings.y = p.offsetTop;
      saveSettings();
    });

    // Header controls
    p.querySelectorAll(".tvso-controls span").forEach(el => {
      el.addEventListener("click", async () => {
        const act = el.dataset.act;
        if (act === "collapse") {
          p.classList.toggle("tvso-collapsed");
          settings.collapsed = p.classList.contains("tvso-collapsed");
          saveSettings();
        } else if (act === "reset-pos") {
          settings.x = null; settings.y = null;
          p.style.left = ""; p.style.right = "20px"; p.style.top = "80px";
          saveSettings();
        } else if (act === "refresh") {
          await loadData();
          render(p);
        } else if (act === "settings") {
          settings.settingsOpen = !settings.settingsOpen;
          p.querySelector(".tvso-settings").hidden = !settings.settingsOpen;
          saveSettings();
        }
      });
    });

    // Settings drawer inputs
    p.querySelectorAll("[data-set]").forEach(inp => {
      const key = inp.dataset.set;
      inp.addEventListener("input", () => {
        let v = inp.value;
        if (inp.type === "range" || inp.type === "number") v = parseFloat(v);
        settings[key] = v;
        const tag = p.querySelector(`[data-set-val="${key}"]`);
        if (tag) tag.textContent = v;
        applyCosmetics(p);
        render(p);
      });
      inp.addEventListener("change", saveSettings);
    });

    p.querySelector('[data-act="reset-defaults"]')?.addEventListener("click", () => {
      // Keep position + open state, reset everything else
      const x = settings.x, y = settings.y, open = settings.settingsOpen;
      Object.assign(settings, DEFAULT_SETTINGS);
      settings.x = x; settings.y = y; settings.settingsOpen = open;
      saveSettings();
      applyCosmetics(p);
      syncSettingsInputs(p);
      render(p);
    });

    // Mode toggle
    p.querySelectorAll('[data-role="mode"] .tvso-tbtn').forEach(btn => {
      btn.addEventListener("click", () => {
        settings.mode = btn.dataset.mode;
        p.querySelectorAll('[data-role="mode"] .tvso-tbtn').forEach(b =>
          b.classList.toggle("tvso-active", b.dataset.mode === settings.mode));
        saveSettings();
        render(p);
      });
    });

    // Period slider
    const slider = p.querySelector('input[type=range]');
    const sval = p.querySelector(".tvso-sval");
    slider.addEventListener("input", () => {
      settings.periods = parseInt(slider.value, 10);
      sval.textContent = settings.periods;
      render(p);
    });
    slider.addEventListener("change", saveSettings);

    // As-of date picker
    const dateInput = p.querySelector(".tvso-date-input");
    dateInput.addEventListener("change", () => {
      settings.asOf = dateInput.value || null;
      saveSettings();
      render(p);
    });
    p.querySelector('[data-act="asof-clear"]').addEventListener("click", () => {
      settings.asOf = null;
      dateInput.value = "";
      saveSettings();
      render(p);
    });

    // Delta toggle
    p.querySelectorAll('[data-role="delta"] .tvso-tbtn').forEach(btn => {
      btn.addEventListener("click", () => {
        if (!btn.dataset.delta) return;
        settings.delta = btn.dataset.delta;
        p.querySelectorAll('[data-role="delta"] .tvso-tbtn').forEach(b =>
          b.classList.toggle("tvso-active", b.dataset.delta === settings.delta));
        saveSettings();
        render(p);
      });
    });
  }

  /* ============================================================
   * Cosmetics — apply user theme via CSS variables
   * ============================================================ */
  function applyCosmetics(p) {
    if (!p) return;
    p.style.width = settings.width + "px";
    p.style.fontSize = settings.fontSize + "px";
    p.style.setProperty("--tvso-bg", settings.panelBg);
    p.style.setProperty("--tvso-fg", settings.textColor);
    p.style.setProperty("--tvso-good", settings.colorGood);
    p.style.setProperty("--tvso-warn", settings.colorWarn);
    p.style.setProperty("--tvso-bad", settings.colorBad);
    p.style.setProperty("--tvso-na", settings.colorNa);
    p.style.setProperty("--tvso-opacity", String(settings.opacity / 100));
    p.style.color = settings.textColor;
  }

  function syncSettingsInputs(p) {
    if (!p) return;
    p.querySelectorAll("[data-set]").forEach(inp => {
      const k = inp.dataset.set;
      if (settings[k] != null) inp.value = settings[k];
      const tag = p.querySelector(`[data-set-val="${k}"]`);
      if (tag) tag.textContent = settings[k];
    });
    p.querySelector(".tvso-settings").hidden = !settings.settingsOpen;
  }

  /* ============================================================
   * Render
   * ============================================================ */
  function render(p) {
    if (!p) return;

    // Always force panel visible on each render (re-shows after stale hide)
    p.style.display = "";

    // Sync settings into UI (in case settings were loaded after panel built)
    p.querySelectorAll('[data-role="mode"] .tvso-tbtn').forEach(b =>
      b.classList.toggle("tvso-active", b.dataset.mode === settings.mode));
    p.querySelectorAll('[data-role="delta"] .tvso-tbtn').forEach(b =>
      b.classList.toggle("tvso-active", b.dataset.delta === settings.delta));
    const slider = p.querySelector('input[type=range]');
    slider.value = settings.periods;
    p.querySelector(".tvso-sval").textContent = settings.periods;
    const dateInput = p.querySelector(".tvso-date-input");
    if (dateInput) dateInput.value = settings.asOf || "";

    // Show/hide delta column header
    const deltaHeader = p.querySelector(".tvso-col-delta");
    if (deltaHeader) deltaHeader.hidden = (settings.delta === "off");

    const sym = readCurrentSymbol();
    const slug = lookupTV(sym);
    const stock = slug ? DATA.stocks[slug] : null;

    p.querySelector(".tvso-ticker-name").textContent = sym || "—";
    p.querySelector(".tvso-ticker-sub").textContent = stock ? stock.name : (sym ? "Not in data" : "Open a stock chart");

    const updEl = p.querySelector(".tvso-updated");
    updEl.textContent = DATA && DATA.as_of ? "Updated " + DATA.as_of.replace("T", " ").slice(0, 16) : "—";
    const statusEl = p.querySelector(".tvso-status");
    const statusText = p.querySelector(".tvso-status-text");
    statusEl.className = "tvso-status " + (
      dataSource === "server" ? "tvso-status-ok" :
      dataSource === "bundled" ? "tvso-status-bad" : "tvso-status-bad"
    );
    statusText.textContent = dataSource === "local" ? "live (local)"
      : dataSource === "cloud" ? "live (cloud)"
      : dataSource === "bundled" ? "bundled (offline)"
      : dataSource === "remote" ? "live"
      : "no data";

    const tbody = p.querySelector(".tvso-hist tbody");
    const setCell = (k, v, klass) => {
      const el = p.querySelector(`[data-k="${k}"]`);
      if (!el) return;
      el.textContent = v;
      el.classList.remove("tvso-good", "tvso-warn", "tvso-bad", "tvso-na");
      if (klass) el.classList.add(klass);
    };

    if (!stock) {
      setCell("prom", "—"); setCell("ple", "—"); setCell("rpt", "—");
      setCell("prom-p", ""); setCell("ple-p", ""); setCell("rpt-p", "");
      tbody.innerHTML = `<tr><td colspan="4" class="tvso-empty">
        ${sym ? `No data for <code>${sym}</code>.` : "Open a TradingView stock chart."}
        <br>Run <code>scrape_shareholding.py</code> to populate data.
      </td></tr>`;
      return;
    }

    // Apply as-of filter to all series (full history retained for delta lookups)
    const promFull = settings.mode === "q" ? (stock.promoter_q || []) : (stock.promoter_fy || []);
    const pleFull  = settings.mode === "q" ? (stock.pledge_q || []) : (stock.pledge_fy || []);
    const rptFull  = stock.rpt_fy || [];
    const promArr = filterByAsOf(promFull, settings.asOf);
    const pleArr  = filterByAsOf(pleFull,  settings.asOf);
    const rptArr  = filterByAsOf(rptFull,  settings.asOf);

    const lProm = promArr[0], lPle = pleArr[0], lRpt = rptArr[0];
    // Latest cells (with optional delta tag)
    let promExtra = "", pleExtra = "", rptExtra = "";
    if (settings.delta !== "off") {
      const promCmp = lProm ? findCompareValue(promFull, lProm.p, settings.delta) : null;
      const pleCmp  = lPle  ? findCompareValue(pleFull,  lPle.p,  settings.delta) : null;
      const rptCmp  = lRpt  ? findCompareValue(rptFull,  lRpt.p,  settings.delta) : null;
      const dProm = (lProm && promCmp && lProm.v != null && promCmp.v != null) ? lProm.v - promCmp.v : null;
      const dPle  = (lPle  && pleCmp  && lPle.v  != null && pleCmp.v  != null) ? lPle.v  - pleCmp.v  : null;
      const dRpt  = (lRpt  && rptCmp  && lRpt.v  != null && rptCmp.v  != null) ? lRpt.v  - rptCmp.v  : null;
      const lbl = settings.delta.toUpperCase();
      if (dProm != null) promExtra = `<div class="tvso-cdelta ${deltaCls(dProm)}">${fmtDelta(dProm)} <small>${lbl}</small></div>`;
      if (dPle  != null) pleExtra  = `<div class="tvso-cdelta ${deltaCls(-dPle)}">${fmtDelta(dPle)} <small>${lbl}</small></div>`; // negate sign for pledge (less = better)
      if (dRpt  != null) rptExtra  = `<div class="tvso-cdelta ${deltaCls(-dRpt)}">${fmtDelta(dRpt)} <small>${lbl}</small></div>`;
    }
    const promCell = p.querySelector('[data-k="prom"]');
    const pleCell  = p.querySelector('[data-k="ple"]');
    const rptCell  = p.querySelector('[data-k="rpt"]');
    setCell("prom", fmt(lProm?.v), clsProm(lProm?.v));
    setCell("ple",  fmt(lPle?.v),  clsPledge(lPle?.v));
    setCell("rpt",  fmt(lRpt?.v),  clsRpt(lRpt?.v));
    // Clear stale delta tags then inject fresh ones
    p.querySelectorAll('[data-extra]').forEach(el => el.remove());
    if (promExtra && promCell) promCell.insertAdjacentHTML("afterend", `<span data-extra="prom">${promExtra}</span>`);
    if (pleExtra  && pleCell)  pleCell.insertAdjacentHTML("afterend",  `<span data-extra="ple">${pleExtra}</span>`);
    if (rptExtra  && rptCell)  rptCell.insertAdjacentHTML("afterend",  `<span data-extra="rpt">${rptExtra}</span>`);
    setCell("prom-p", lProm?.p || "—");
    setCell("ple-p",  lPle?.p  || "—");
    setCell("rpt-p",  lRpt?.p  || "—");

    // History rows (post-asOf)
    const n = settings.periods;
    const rows = promArr.slice(0, n);
    const showDelta = settings.delta !== "off";
    tbody.innerHTML = rows.length
      ? rows.map((r, i) => {
          const ple = pleArr[i];
          const rpt = settings.mode === "q" ? null : rptArr[i];
          const rptCellHtml = settings.mode === "q"
            ? `<td><span class="tvso-na">—</span></td>`
            : `<td class="${clsRpt(rpt?.v)}">${fmt(rpt?.v)}</td>`;
          let deltaCell = "";
          if (showDelta) {
            const cmp = findCompareValue(promFull, r.p, settings.delta);
            const d = (r.v != null && cmp && cmp.v != null) ? r.v - cmp.v : null;
            deltaCell = `<td class="${deltaCls(d)}">${d == null ? '—' : fmtDelta(d)}</td>`;
          }
          return `<tr>
            <td>${r.p}</td>
            <td class="${clsProm(r.v)}">${fmt(r.v)}</td>
            <td class="${clsPledge(ple?.v)}">${fmt(ple?.v)}</td>
            ${rptCellHtml}
            ${deltaCell}
          </tr>`;
        }).join("")
      : `<tr><td colspan="${showDelta ? 5 : 4}" class="tvso-empty">No history rows in chosen window.</td></tr>`;
  }

  /* ============================================================
   * Settings persistence
   * ============================================================ */
  function loadSettings() {
    return new Promise(res => {
      try {
        chrome.storage.local.get([STORAGE_KEY], r => {
          if (r && r[STORAGE_KEY]) Object.assign(settings, r[STORAGE_KEY]);
          res();
        });
      } catch (_) { res(); }
    });
  }
  function saveSettings() {
    try { chrome.storage.local.set({ [STORAGE_KEY]: settings }); } catch (_) {}
  }

  /* ============================================================
   * Symbol-change watcher
   * ============================================================ */
  function watchSymbol(panel) {
    const tick = () => {
      const sym = readCurrentSymbol();
      if (sym !== currentSlug) {
        console.log(`[TVSO] symbol change: ${currentSlug} -> ${sym}`);
        currentSlug = sym;
        render(panel);
      }
    };
    setInterval(tick, 800);

    // Watch URL + title changes (TV updates either depending on flow)
    let lastUrl = location.href;
    let lastTitle = document.title;
    new MutationObserver(() => {
      if (location.href !== lastUrl || document.title !== lastTitle) {
        lastUrl = location.href;
        lastTitle = document.title;
        tick();
      }
    }).observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
    });
  }

  /* ============================================================
   * Init
   * ============================================================ */
  async function init() {
    console.log("[TVSO] init() start");
    let panel;
    try {
      await loadSettings();
      console.log("[TVSO] settings loaded", settings);
    } catch (e) {
      console.warn("[TVSO] loadSettings failed", e);
    }

    // Build panel FIRST so it's visible even if data fetch fails
    try {
      panel = buildPanel();
      console.log("[TVSO] panel built", panel);
    } catch (e) {
      console.error("[TVSO] buildPanel FAILED", e);
      return;
    }

    try {
      await loadData();
      console.log(`[TVSO] data loaded src=${dataSource} stocks=${Object.keys(DATA?.stocks||{}).length}`);
    } catch (e) {
      console.warn("[TVSO] loadData failed", e);
    }

    try {
      render(panel);
      console.log("[TVSO] initial render done. symbol=", readCurrentSymbol());
    } catch (e) {
      console.error("[TVSO] render failed", e);
    }

    watchSymbol(panel);
  }

  // Wait for DOM body if not ready yet
  if (document.body) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  }
})();
