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
  const VERSION = "0.5.0";
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
  // Per-URL cooldown after failure: skip for 5 min on connection error
  const URL_FAIL_COOLDOWN_MS = 5 * 60 * 1000;
  const _urlFailedAt = {};

  async function loadData() {
    const sources = (settings.dataSources && settings.dataSources.length)
      ? settings.dataSources
      : DEFAULT_DATA_SOURCES;
    const now = Date.now();
    for (const url of sources) {
      // Skip URLs that recently failed
      if (_urlFailedAt[url] && (now - _urlFailedAt[url]) < URL_FAIL_COOLDOWN_MS) {
        continue;
      }
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.ok) {
          DATA = await r.json();
          dataSource = url.startsWith("http://127.") ? "local"
            : url.includes("raw.githubusercontent") ? "cloud"
            : "remote";
          delete _urlFailedAt[url];
          console.log(`[TVSO] loaded from ${dataSource} (${url})`);
          return;
        }
        _urlFailedAt[url] = now;
      } catch (_) {
        _urlFailedAt[url] = now;
        /* try next */
      }
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
    let exchange = null, ticker = null;

    // FIRST: read TV's chart header pill button — this updates on every chart change.
    // Confirmed selector (verified on TV 2026-05): button#header-toolbar-symbol-search
    try {
      const pill = document.querySelector(
        'button#header-toolbar-symbol-search, '
        + 'button[id*="header-toolbar-symbol-search"]'
      );
      if (pill) {
        const t = (pill.textContent || "").trim();
        const m = t.match(/^([A-Z][A-Z0-9_\-&\.]{0,30})$/);
        if (m) ticker = m[1];
      }
      // Fallback pill selectors if id not found (different TV versions)
      if (!ticker) {
        const pills = document.querySelectorAll(
          '[class*="symbolNameText"], [class*="tv-symbol"], '
          + '[class*="symbolButton"], [class*="mainSymbol"]'
        );
        for (const el of pills) {
          const t = (el.textContent || "").trim();
          const m = t.match(/^([A-Z][A-Z0-9_\-&\.]{0,30})$/);
          if (m) { ticker = m[1]; break; }
        }
      }
    } catch (_) {}

    // SECOND: derive exchange from chart legend "Company · 3M · NSE"
    try {
      const legends = document.querySelectorAll(
        '[data-name="legend-source-title"], [class*="mainTitle"]'
      );
      for (const el of legends) {
        const t = (el.textContent || "").trim();
        const m = t.match(/[·•|]\s*(NSE|BSE|MCX|NCDEX|NASDAQ|NYSE|LSE|HKEX|FX|FOREX|CRYPTO|BINANCE)\b/);
        if (m) { exchange = m[1]; break; }
      }
    } catch (_) {}

    if (ticker && exchange) return `${exchange}:${ticker}`;
    if (ticker) return `NSE:${ticker}`;  // Indian default when exchange unknown

    // Fallback chain
    // document.title
    const t1 = document.title.match(/\b(NSE|BSE|MCX|NCDEX|NASDAQ|NYSE|LSE|HKEX)[:\s]+([A-Z0-9_\-&]+)/);
    if (t1) return `${t1[1]}:${t1[2]}`;
    const t2 = document.title.match(/^([A-Z]+):([A-Z0-9_\-&]+)/);
    if (t2) return `${t2[1]}:${t2[2]}`;

    // URL ?symbol= (stale during SPA navigation but useful on first load)
    try {
      const u = new URL(window.location.href);
      const s = u.searchParams.get("symbol");
      if (s) return decodeURIComponent(s).toUpperCase();
    } catch (_) {}

    // /symbols/EXCHANGE-TICKER/
    const mp = window.location.pathname.match(/\/symbols\/([A-Z]+)-([A-Z0-9_\-&]+)/i);
    if (mp) return `${mp[1].toUpperCase()}:${mp[2].toUpperCase()}`;

    // If we have only ticker, assume NSE (most Indian charts)
    if (ticker && !exchange) return `NSE:${ticker}`;

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
  // Vijay-Malik thresholds:
  //   sales/purchases vs revenue: 25% green / 50% orange / >50% red
  //   loans vs net worth:         25% green / 50% orange / >50% red
  function clsRptSales(v) {
    if (v == null) return "tvso-na";
    if (v <= 25) return "tvso-good";
    if (v <= 50) return "tvso-warn";
    return "tvso-bad";
  }
  function clsRptPurch(v) {
    if (v == null) return "tvso-na";
    if (v <= 25) return "tvso-good";
    if (v <= 50) return "tvso-warn";
    return "tvso-bad";
  }
  function clsRptLoans(v) {
    if (v == null) return "tvso-na";
    if (v <= 25) return "tvso-good";
    if (v <= 50) return "tvso-warn";
    return "tvso-bad";
  }
  function fmt(v) { return v == null ? "N/A" : v.toFixed(2) + "%"; }

  /* ============================================================
   * Metric definitions — used by (i) info popovers
   * ============================================================ */
  const METRIC_INFO = {
    "prom": {
      title: "Promoter Holding",
      what: "Promoter+promoter group's stake in the company.",
      how: "Reported by company in BSE/NSE shareholding pattern, every quarter.",
      bands: [
        ["≥ 50%", "good — strong skin in game"],
        ["25–50%", "watch — diluted control"],
        ["< 25%", "weak — promoter has limited stake"],
      ],
      why: "Skin in the game. Falling promoter holding over years = warning of dilution / promoter exit.",
    },
    "pledge": {
      title: "Pledged % of Promoter Holding",
      what: "Share of promoter holding pledged with banks / NBFCs as collateral.",
      how: "From SEBI SAST disclosures filed quarterly with BSE/NSE.",
      bands: [
        ["≤ 5%", "good"],
        ["5–25%", "watch"],
        ["> 25%", "red flag — high default risk; if invocation, supply pressure on stock"],
      ],
      why: "Pledge = promoter borrowed against shares. High pledge + falling stock = forced sell spiral.",
    },
    "rpt": {
      title: "Related Party Transactions (RPT)",
      what: "Business deals between the company and entities owned by the promoter group / directors / their relatives.",
      how: "Annual report Note on RPT, classified into 3 buckets: Sales (revenue side), Purchases (expense side), and Loans/Investments (capital side).",
      why: "Heavy RPT = potential value siphoning. Vijay Malik framework: track each bucket separately. Aggregate % is misleading — different buckets need different denominators.",
    },
    "rpt-sales": {
      title: "RPT — Sales / Total Revenue",
      what: "Revenue earned from related parties as % of total standalone sales.",
      how: "Sum of all sales-side RPT lines in annual report ÷ Sales.",
      bands: [
        ["≤ 25%", "OK"],
        ["25–50%", "concentration risk — ask why"],
        ["> 50%", "captive customer — earnings depend on group"],
      ],
      why: "If most revenue comes from group entities, a falling-out or transfer-pricing audit can wipe out the business.",
    },
    "rpt-purch": {
      title: "RPT — Purchases / Total Revenue",
      what: "Expenses paid to related parties (raw material, services, rent, royalty, fees, salary) as % of revenue.",
      how: "Sum of all expense-side RPT lines ÷ Sales.",
      bands: [
        ["≤ 25%", "OK"],
        ["25–50%", "captive sourcing — check pricing benchmarks"],
        ["> 50%", "value siphoning suspected — costs may be inflated to enrich promoter entities"],
      ],
      why: "Above-market pricing on group purchases = quiet wealth transfer. >100% means the company spends more on RP than it earns from outside customers.",
    },
    "rpt-loans": {
      title: "RPT — Loans+Investments / Net Worth",
      what: "Loans given, advances given and equity invested in related parties as % of company's net worth.",
      how: "Sum of capital-flow RPT lines ÷ Equity (Share Capital + Reserves).",
      bands: [
        ["≤ 25%", "OK"],
        ["25–50%", "watch — diversion of shareholder funds"],
        ["> 50%", "round-tripping / fund-diversion risk — promoter using minority cash"],
      ],
      why: "Lending company cash to group entities at sub-market rates effectively transfers wealth from minority shareholders to promoter family.",
    },
  };
  function showInfoPopover(panel, key, anchorEl) {
    const meta = METRIC_INFO[key];
    if (!meta) return;
    // Remove any existing popover
    panel.querySelectorAll(".tvso-popover").forEach(el => el.remove());
    const pop = document.createElement("div");
    pop.className = "tvso-popover";
    let bandsHTML = "";
    if (meta.bands) {
      bandsHTML = '<div class="tvso-pop-bands">' +
        meta.bands.map(([range, txt]) =>
          `<div class="tvso-pop-band"><span class="tvso-pop-range">${range}</span> ${txt}</div>`
        ).join("") + '</div>';
    }
    pop.innerHTML = `
      <div class="tvso-pop-title">${meta.title}<span class="tvso-pop-close">×</span></div>
      <div class="tvso-pop-what"><strong>What:</strong> ${meta.what}</div>
      ${meta.how ? `<div class="tvso-pop-how"><strong>Source:</strong> ${meta.how}</div>` : ""}
      ${bandsHTML}
      ${meta.why ? `<div class="tvso-pop-why"><strong>Why it matters:</strong> ${meta.why}</div>` : ""}
    `;
    panel.appendChild(pop);
    pop.querySelector(".tvso-pop-close").addEventListener("click", () => pop.remove());
    // Close on outside click
    setTimeout(() => {
      const off = (e) => {
        if (!pop.contains(e.target) && !e.target.classList.contains("tvso-info")) {
          pop.remove();
          document.removeEventListener("click", off, true);
        }
      };
      document.addEventListener("click", off, true);
    }, 50);
  }

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
        <div class="tvso-latest tvso-latest-2">
          <div class="tvso-cell">
            <div class="tvso-clabel">Promoter <span class="tvso-info" data-info="prom">i</span></div>
            <div class="tvso-cval" data-k="prom">—</div>
            <div class="tvso-cper" data-k="prom-p">—</div>
          </div>
          <div class="tvso-cell">
            <div class="tvso-clabel">Pledge <span class="tvso-info" data-info="pledge">i</span></div>
            <div class="tvso-cval" data-k="ple">—</div>
            <div class="tvso-cper" data-k="ple-p">—</div>
          </div>
        </div>
        <div class="tvso-rpt-grid">
          <div class="tvso-rpt-title">Related-Party Transactions <span class="tvso-info" data-info="rpt">i</span></div>
          <div class="tvso-rpt-cells">
            <div class="tvso-rcell">
              <div class="tvso-rlabel">Sales <span class="tvso-info" data-info="rpt-sales">i</span></div>
              <div class="tvso-rval" data-k="rpt-sales">—</div>
            </div>
            <div class="tvso-rcell">
              <div class="tvso-rlabel">Purch. <span class="tvso-info" data-info="rpt-purch">i</span></div>
              <div class="tvso-rval" data-k="rpt-purch">—</div>
            </div>
            <div class="tvso-rcell">
              <div class="tvso-rlabel">Loans <span class="tvso-info" data-info="rpt-loans">i</span></div>
              <div class="tvso-rval" data-k="rpt-loans">—</div>
            </div>
          </div>
          <div class="tvso-rpt-period" data-k="rpt-p">—</div>
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
    // Info icons - delegate click anywhere on .tvso-info inside panel
    p.addEventListener("click", e => {
      const info = e.target.closest(".tvso-info");
      if (info && info.dataset.info) {
        e.stopPropagation();
        showInfoPopover(p, info.dataset.info, info);
      }
    });

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
      setCell("prom", "—"); setCell("ple", "—");
      setCell("rpt-sales", "—"); setCell("rpt-purch", "—"); setCell("rpt-loans", "—");
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
    const rptSalesFull = stock.rpt_sales_fy || [];
    const rptPurchFull = stock.rpt_purchases_fy || [];
    const rptLoansFull = stock.rpt_loans_fy || [];
    const promArr = filterByAsOf(promFull, settings.asOf);
    const pleArr  = filterByAsOf(pleFull,  settings.asOf);
    const rptArr  = filterByAsOf(rptFull,  settings.asOf);
    const rptSalesArr = filterByAsOf(rptSalesFull, settings.asOf);
    const rptPurchArr = filterByAsOf(rptPurchFull, settings.asOf);
    const rptLoansArr = filterByAsOf(rptLoansFull, settings.asOf);

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
    setCell("prom", fmt(lProm?.v), clsProm(lProm?.v));
    setCell("ple",  fmt(lPle?.v),  clsPledge(lPle?.v));
    // Clear stale delta tags then inject fresh ones
    p.querySelectorAll('[data-extra]').forEach(el => el.remove());
    if (promExtra && promCell) promCell.insertAdjacentHTML("afterend", `<span data-extra="prom">${promExtra}</span>`);
    if (pleExtra  && pleCell)  pleCell.insertAdjacentHTML("afterend",  `<span data-extra="ple">${pleExtra}</span>`);
    setCell("prom-p", lProm?.p || "—");
    setCell("ple-p",  lPle?.p  || "—");

    // RPT sub-cells
    const lRptSales = rptSalesArr[0], lRptPurch = rptPurchArr[0], lRptLoans = rptLoansArr[0];
    setCell("rpt-sales", fmt(lRptSales?.v), clsRptSales(lRptSales?.v));
    setCell("rpt-purch", fmt(lRptPurch?.v), clsRptPurch(lRptPurch?.v));
    setCell("rpt-loans", fmt(lRptLoans?.v), clsRptLoans(lRptLoans?.v));
    // RPT period — show latest available across all three sub-metrics
    const rptPeriod = lRptSales?.p || lRptPurch?.p || lRptLoans?.p || lRpt?.p || "—";
    setCell("rpt-p", rptPeriod);

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
