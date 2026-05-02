# TV Shareholding Overlay

A floating panel pinned to your TradingView chart that shows, for whichever
Indian stock you have open:

- **Promoter holding %** — quarterly + 10+ years of annual history
- **Pledged % of promoter holding** — quarterly + 10+ years of annual history
- **Related-Party Transactions / Sales %** — annual, 10+ years

The panel auto-updates as you scroll between charts. No clicks. No copy-paste.

| Component | Role |
|---|---|
| **Chrome extension** (`extension/`) | Renders the panel on `tradingview.com/chart/*`. Auto-detects symbol. |
| **Python scraper** (`scrape_shareholding.py`) | Pulls fresh data from screener.in (with BSE/NSE direct as fallback). Writes `extension/data.json`. |
| **Universe builder** (`fetch_universe.py`) | One-time. Pulls full NSE+BSE listed-stock master list. |
| **Local data server** (`data_server.py`) | Tiny HTTP server on `127.0.0.1:8765`. Extension fetches `data.json` from it. |
| **Scheduler script** (`setup_scheduler.ps1`) | Registers Windows tasks: server at logon, scraper daily 21:30. |

---

## 1 · Preview before installing

Open `MOCKUP_preview.html` in Chrome. That is exactly what the panel will
look like, with three demo stocks you can cycle through.

---

## 2 · Install (one time, ~10 minutes)

You only do this once. After that everything self-updates.

### Step 2.1 — Install Python (skip if already installed)

1. Get Python 3.10 or newer from <https://python.org/downloads/>.
2. **During install, tick "Add Python to PATH".**
3. Reboot if asked.

Verify by opening Command Prompt and typing:
```
python --version
```
You should see e.g. `Python 3.12.3`.

### Step 2.2 — Install the Python libraries

In Command Prompt, navigate to this folder and run:
```
cd "D:\Dropbox\2025 Entry Valuations of Stocks of Vijay malik and shreyansh mehta\Claude Scripts 26-04-2026\tv-shareholding-overlay"
pip install -r requirements.txt
```

### Step 2.3 — Build the universe (full NSE + BSE list)

```
python fetch_universe.py
```
Creates `universe.csv` with ~5000 rows (NSE + BSE-only stocks). Re-run
once a month to pick up new listings.

### Step 2.4 — First scrape (test with 20 stocks first)

```
python scrape_shareholding.py --max 20
```
Takes ~1 minute. Verifies your network + screener.in are reachable. Look
at the printout: most should say `OK`. If most say `FAIL`, something is
wrong with your network or screener changed its HTML — open an issue
with me.

Then full scrape (~3 hours, leave it running):
```
python scrape_shareholding.py
```

The scraper is **resumable**. If it crashes or you Ctrl-C it, just run
again with `--resume`:
```
python scrape_shareholding.py --resume
```
It will skip stocks already in `extension/data.json`.

### Step 2.5 — Start the local data server

```
python data_server.py
```
Leave this window open. You should see:
```
Serving D:\...\extension\data.json on http://127.0.0.1:8765/data.json
```

### Step 2.6 — Load the Chrome extension

1. Open Chrome, go to <chrome://extensions>.
2. Toggle **Developer mode** ON (top-right).
3. Click **Load unpacked**.
4. Pick the `extension/` folder inside this project.
5. The extension card should appear named *TV Shareholding Overlay*.

Now open any Indian stock chart on tradingview.com (e.g.
<https://www.tradingview.com/chart/?symbol=NSE%3ARELIANCE>). The panel
will appear top-right.

### Step 2.7 — Make it permanent (auto-start on boot)

Open PowerShell **as Administrator**, then:
```powershell
cd "D:\Dropbox\2025 Entry Valuations of Stocks of Vijay malik and shreyansh mehta\Claude Scripts 26-04-2026\tv-shareholding-overlay"
powershell -ExecutionPolicy Bypass -File .\setup_scheduler.ps1
```
This registers two scheduled tasks:
- `TVOverlay_Server` — runs at logon, keeps `data_server.py` alive
- `TVOverlay_Scrape` — runs daily 21:30, refreshes `data.json`

You can stop using the manual `python data_server.py` window now;
Windows will start the server for you on every login.

---

## 3 · How the panel works

| Element | What it does |
|---|---|
| **Drag the header** | Move panel anywhere. Position remembered next session. |
| **− (minus) icon** | Collapse to a thin strip (still shows ticker). Click again to expand. |
| **× (close) icon** | Hide for current page. Reload to bring back. |
| **↻ icon** | Re-fetch `data.json` from local server (use after a fresh scrape). |
| **FY / Quarterly toggle** | Switch the history table between annual and quarterly. RPT is annual-only — column shows `—` in quarterly mode. |
| **Periods slider** | 3 to 20. How many history rows to show. Default 10. |
| **Color coding** | Green = clean, orange = watch, red = red flag. |

### Threshold legend

| Metric | Green | Orange | Red |
|---|---|---|---|
| Promoter holding | ≥ 50% | 25–50% | < 25% |
| Pledged % | ≤ 5% | 5–25% | > 25% |
| RPT / Sales | ≤ 5% | 5–10% | > 10% |

Edit thresholds inside `extension/content.js` (`clsProm`, `clsPledge`,
`clsRpt`) and reload the extension on `chrome://extensions` if you want
different bands.

---

## 4 · Honest disclaimers

- **Screener.in primary source.** If they change their HTML, the
  scraper breaks until selectors are patched. The fallback path uses
  BSE corporate filings API, but that doesn't have the same depth of
  history.
- **RPT is hardest.** It's pulled from screener's "Related Party
  Transactions" schedule and divided by Sales. For some companies the
  schedule is empty in screener (small caps, recent listings). Those
  rows will show `N/A`.
- **Quarterly RPT does not exist** as standardised data. Only annual.
  When the toggle is set to *Quarterly* the RPT column shows `—`.
- **First scrape is slow.** ~3 hours for the full universe at 2-second
  delay. The delay exists to be polite to screener.in. Reduce with
  `--delay 1.0` at your own risk of being throttled.
- **Quarterly disclosures lag.** BSE/NSE allow companies up to 21 days
  after quarter end to file shareholding patterns; some take 45 days.
  So Q3-FY26 (Dec 2025) data shows up between Jan 8 and Feb 14, 2026.
- **Symbol mapping isn't perfect.** ~5% of TV tickers may not map
  cleanly (delisted, renamed, BSE-only with weird codes). Panel will
  show *Not in data* for those. You can manually add a mapping in
  `extension/data.json` under `by_tv`.
- **Extension stays in dev mode.** Without paying Google's $5
  publisher fee + signing, it must be loaded as an unpacked extension.
  Chrome will prompt every restart with a "Disable developer mode
  extensions" warning — click **Cancel** to keep it.

---

## 5 · Updating

Daily, automatic, while logged in:
- 21:30 IST — `TVOverlay_Scrape` task runs, refreshes `data.json`
- Next time you visit a TradingView chart, click **↻** on the panel to
  pull the new data immediately. Or wait, the extension re-fetches on
  every page load anyway.

To update the universe (catch newly listed companies), once a month:
```
python fetch_universe.py
```

---

## 6 · Troubleshooting

| Symptom | Fix |
|---|---|
| Panel doesn't appear on TradingView | Check `chrome://extensions` — is *TV Shareholding Overlay* enabled? Reload the chart page. |
| Footer shows red dot, "bundled (server offline)" | Local server isn't running. Run `python data_server.py` or `Start-ScheduledTask -TaskName TVOverlay_Server`. |
| Footer shows red dot, "no data" | Neither server nor bundled `data.json` reachable. Re-load the unpacked extension. |
| Panel shows *Not in data* for a symbol you know is listed | Add a row to `extension/data.json` under `by_tv` mapping `EXCHANGE:TICKER` → screener slug. Or run `python scrape_shareholding.py --symbols TICKERNAME`. |
| Scraper says lots of `FAIL` rows | Increase `--delay 3.0` to be politer. If still failing, screener may have changed HTML — flag to me. |
| Scheduled task doesn't run | Open Task Scheduler, find `TVOverlay_*`, check "Last Run Result". Common cause: PATH not set for `python`. Edit the action to use the full path, e.g. `C:\Python312\python.exe`. |
| Panel position drifts off-screen | Open DevTools console on TV, run `localStorage.removeItem('tvso_settings_v1')`, reload. (Or right-click extension → *Inspect popup*.) |

---

## 7 · File reference

```
tv-shareholding-overlay/
├── README.md                    # this file
├── MOCKUP_preview.html          # static preview - open in Chrome
├── requirements.txt
├── fetch_universe.py            # one-time: build universe.csv
├── scrape_shareholding.py       # daily: refresh extension/data.json
├── data_server.py               # always-on: serve data.json on :8765
├── setup_scheduler.ps1          # one-time: register Windows tasks
├── universe.csv                 # generated by fetch_universe.py
├── logs/                        # task scheduler logs
└── extension/                   # the Chrome extension (load unpacked)
    ├── manifest.json
    ├── content.js
    ├── panel.css
    └── data.json                # refreshed by scraper
```
