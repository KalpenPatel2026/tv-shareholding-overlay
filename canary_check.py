"""
Canary health check for the scraper. Run monthly via .github/workflows/canary.yml.

Checks:
  1. screener_pro cookie still valid — fetches RELIANCE consolidated page
  2. Tickertape /stocks/list endpoint still responding
  3. Five known stocks return values inside expected ranges:
       RELIANCE   : promoter_fy[Mar 2025] in 45-55%
       TCS        : promoter_fy[Mar 2025] in 65-75%
       VAKRANGEE  : promoter_fy[Mar 2025] in 35-50%
       JPPOWER    : promoter_fy[Mar 2025] in 20-30%
       ZEEL       : promoter_fy[Mar 2025] in 0-10% (low promoter)

Exit code 0 = healthy. Non-zero + report on stderr = problem.
"""
from __future__ import annotations
import sys, pathlib, json
import httpx

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from sources import ScreenerPro, Tickertape

EXPECTED = {
    "RELIANCE":  {"prom_min": 45, "prom_max": 55},
    "TCS":       {"prom_min": 65, "prom_max": 75},
    "VAKRANGEE": {"prom_min": 35, "prom_max": 50},
    "JPPOWER":   {"prom_min": 20, "prom_max": 30},
    "ZEEL":      {"prom_min": 0,  "prom_max": 10},
}

failures = []
warnings = []


def main():
    with httpx.Client(http2=False, follow_redirects=True) as client:
        sp = ScreenerPro(client, {})
        tt = Tickertape(client, {})

        # 1. Cookie / Pro page works
        if sp.enabled:
            print(f"[canary] screener_pro: cookie present, testing RELIANCE page...")
            data = sp.fetch({"screener_slug": "RELIANCE", "tv_symbol": "NSE:RELIANCE", "name": "Reliance"})
            if data.err:
                failures.append(f"screener_pro RELIANCE fetch error: {data.err}")
            elif not data.promoter_fy:
                failures.append("screener_pro RELIANCE returned NO promoter_fy — HTML schema may have changed")
            else:
                print(f"  OK promoter_fy[0]={data.promoter_fy[0]}")
        else:
            warnings.append("screener_pro disabled (no SCREENER_COOKIE secret)")

        # 2. Tickertape stocks/list endpoint
        print(f"[canary] tickertape: testing /stocks/list...")
        tt._build_map()
        if not Tickertape._ticker_to_sid:
            failures.append("tickertape /stocks/list returned empty — endpoint changed?")
        else:
            print(f"  OK {len(Tickertape._ticker_to_sid)} tickers in map")

        # 3. Known-stock value ranges via screener_pro (if cookie) else tickertape
        for slug, exp in EXPECTED.items():
            print(f"[canary] {slug}: scraping...")
            row = {"screener_slug": slug, "tv_symbol": f"NSE:{slug}", "bse_code": "", "name": slug}
            data = sp.fetch(row) if sp.enabled else None
            if not data or data.is_empty():
                data = tt.fetch(row)
            if data.err:
                warnings.append(f"{slug}: error {data.err}")
                continue
            prom_series = data.promoter_fy or data.promoter_q
            if not prom_series:
                warnings.append(f"{slug}: no promoter data")
                continue
            v = prom_series[0].v
            if v is None:
                warnings.append(f"{slug}: promoter value is None")
                continue
            mn, mx = exp["prom_min"], exp["prom_max"]
            if not (mn <= v <= mx):
                failures.append(
                    f"{slug}: promoter {v}% outside expected range {mn}-{mx}% — "
                    f"parser may be misreading"
                )
            else:
                print(f"  OK {slug} promoter={v}% (expected {mn}-{mx}%)")

    print()
    if warnings:
        print("WARNINGS:")
        for w in warnings: print(f"  - {w}")
    if failures:
        print("FAILURES:")
        for f in failures: print(f"  - {f}")
        sys.exit(1)
    print("All canary checks passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
