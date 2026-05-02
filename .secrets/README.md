# .secrets/

Anything in this folder is **personal credentials**. Never commit it, never paste
it into chat, never share screenshots that show its contents.

## screener_cookie.txt

Required to enable the **screener_pro** data source (gives access to Pledge %
and full RPT/Sales history that the free tier hides).

### How to export your screener.in cookie (one time, ~2 minutes)

1. Open Chrome.
2. Go to <https://www.screener.in> and **log in** with your Pro account.
3. Press **F12** to open Developer Tools.
4. In the top toolbar of DevTools click the **Application** tab.
   (If you don't see it: click the `>>` arrows next to the visible tabs.)
5. In the left sidebar, expand **Cookies** → click **`https://www.screener.in`**.
6. You will see a list of cookies. Find the row whose name is `sessionid`.
7. Double-click the **Value** column for that row → **Ctrl+C** to copy.
8. Open Notepad. Paste the value. Save the file as:
   ```
   D:\Dropbox\2025 Entry Valuations of Stocks of Vijay malik and shreyansh mehta\Claude Scripts 26-04-2026\tv-shareholding-overlay\.secrets\screener_cookie.txt
   ```
   (No quotes around the value, no leading "sessionid=" — just the raw string,
   though either form works.)

### Verify it worked

```
cd "D:\Dropbox\2025 Entry Valuations of Stocks of Vijay malik and shreyansh mehta\Claude Scripts 26-04-2026\tv-shareholding-overlay"
python scrape_shareholding.py --symbols VAKRANGEE --providers screener_pro
```

If the cookie is loaded, you'll see:
```
Active providers: ['screener_pro']
[1/1] OK   VAKRANGEE  (promoter_q=screener_pro pledge_q=screener_pro ... rpt_fy=screener_pro)
```

If you see `[skip] screener_pro: disabled (no cookie)`, the file path or name is
wrong.

### When the cookie expires

Screener sessions last several months but eventually log out. If you start
seeing `[skip] screener_pro: ...` in scraper output again, redo the steps above
with a fresh value. The scraper will fall through to free sources for promoter
holding; only pledge + RPT will go stale.

### Security

* The file is in `.gitignore` and stays on this machine. Do not move it
  elsewhere or sync it through any cloud drive that you share with anyone.
* If you suspect leak: log out of screener.in (revokes the session), log
  back in, redo the export.
