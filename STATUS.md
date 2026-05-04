# TV Shareholding Overlay — Live Status

_Auto-updated hourly. Last refresh: 2026-05-04T20:53Z_

## Coverage

| Metric | Value |
|---|---|
| Stocks scraped | **1426 / 5852** (24.4%) |
| Data as of | 2026-05-03T05:41:25Z |
| data.json age | 13.7 hours |
| Last data commit | `3424cd5 2026-05-04 12:44:26 +0530 ops: 3x daily cron + auto-rerun on failure` |

## Workflow runs

| Workflow | Status | Last run |
|---|---|---|
| Daily scrape | in_progress /  | 2026-05-04T20:48:20Z |
| Monthly canary | - | - |

## Quick links

- Live data: <https://raw.githubusercontent.com/KalpenPatel2026/tv-shareholding-overlay/main/extension/data.json>
- Scrape runs: <https://github.com/KalpenPatel2026/tv-shareholding-overlay/actions/workflows/scrape.yml>
- Canary runs: <https://github.com/KalpenPatel2026/tv-shareholding-overlay/actions/workflows/canary.yml>
- Open issues (canary alerts): <https://github.com/KalpenPatel2026/tv-shareholding-overlay/issues?q=is:issue+is:open+label:canary>

## Health flags

- 🟢 All systems normal if both workflows show `completed / success`
- 🟡 Stale data if data.json age > 30 hours
- 🔴 Canary failed → re-export screener cookie or check parser
