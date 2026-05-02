# Cloud auto-refresh setup (GitHub Actions)

Goal: Scraper runs nightly in GitHub's cloud. Your PC can stay off. Extension reads fresh `data.json` from `https://raw.githubusercontent.com/KalpenPatel2026/tv-shareholding-overlay/main/extension/data.json` whenever you open a TradingView chart.

## One-time setup (~15 minutes)

### Step 1 — Create the GitHub repo

1. Open <https://github.com/new>.
2. Repository name: `tv-shareholding-overlay`
3. Visibility: **Public** (data is already public from screener.in; code is fine to be visible)
4. **Do NOT** initialize with README, .gitignore, or license (we'll push our own files).
5. Click **Create repository**.

### Step 2 — Push the project to GitHub

In Command Prompt:

```
cd "D:\Dropbox\2025 Entry Valuations of Stocks of Vijay malik and shreyansh mehta\Claude Scripts 26-04-2026\tv-shareholding-overlay"
git init
git branch -M main
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/KalpenPatel2026/tv-shareholding-overlay.git
git push -u origin main
```

If `git push` asks for password — use a **Personal Access Token** instead:
- <https://github.com/settings/tokens/new> → name "tv-overlay" → scope `repo` → Generate
- Copy the token, paste when prompted for password

`.gitignore` already excludes `.secrets/screener_cookie.txt` so the cookie does not get pushed.

### Step 3 — Add the cookie as a GitHub Secret

1. Go to <https://github.com/KalpenPatel2026/tv-shareholding-overlay/settings/secrets/actions>
2. Click **New repository secret**
3. Name: `SCREENER_COOKIE`
4. Value: paste the contents of your local `.secrets/screener_cookie.txt` (the sessionid value)
5. Click **Add secret**

GitHub encrypts it. Workflow runs can read it but it never appears in logs.

### Step 4 — Trigger first run

1. Go to <https://github.com/KalpenPatel2026/tv-shareholding-overlay/actions>
2. Click **Daily Shareholding Scrape** in the left sidebar
3. Click **Run workflow** → **Run workflow** (green button)
4. Wait ~1-3 hours. Refresh the page; when the run shows a green checkmark, `extension/data.json` is updated in the repo.

### Step 5 — Point the extension to the cloud copy

Edit `extension/content.js`. Replace the constant `SERVER_URL` with the raw GitHub URL:

```js
const SERVER_URL = "https://raw.githubusercontent.com/KalpenPatel2026/tv-shareholding-overlay/main/extension/data.json";
```

Then reload extension in `chrome://extensions`.

The local `data_server.py` is no longer needed for daily refreshes. Keep it only if you want to scrape locally for testing.

### Step 6 — Verify

- Open any TV chart
- F12 console → look for `[TVSO] data loaded src=server stocks=...`
- Footer of panel shows `live` (green dot)
- Click the ↻ icon to force a fresh fetch

## Schedule

The workflow runs automatically every day at **21:30 IST** (16:00 UTC). Edit `.github/workflows/scrape.yml` `cron` line to change.

## Cookie expiry

Screener sessions usually last several months but eventually expire. When that happens:

1. You'll see most stocks scraped via `tickertape` instead of `screener_pro` in the next run's logs (visible at `/actions/runs/{id}`)
2. Re-export your screener cookie (see `.secrets/README.md`)
3. Update the GitHub Secret `SCREENER_COOKIE` with the fresh value
4. Re-run the workflow manually (Step 4 above)

## Cost

GitHub Actions free tier: 2000 minutes/month for public repos. A nightly scrape uses ~60-90 minutes. Monthly cost: ~2700 min — slightly over free quota for private repos but **public repos have unlimited Actions minutes** (which is why we recommend public).

## Privacy notes

- Code in repo: scraper, extension, README. Public.
- Cookie: never in repo. Encrypted in GitHub Secrets. Only the Actions VM at runtime can read it.
- `data.json`: public on GitHub. The data is already public on screener.in / NSE / Tickertape. No personal data.

## Alternative: Dropbox-based delivery

If you prefer to keep everything in Dropbox without GitHub:

1. Set up a Dropbox app (<https://www.dropbox.com/developers/apps>) → generate access token
2. Add a step to the workflow that uploads `data.json` to your Dropbox via API
3. Extension fetches via Dropbox shared-link URL

More complex than GitHub-raw. Use only if you really want to avoid GitHub.
