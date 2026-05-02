"""
Build universe.csv = the list of (tradingview_symbol, screener_slug, bse_code, name)
that the scraper will iterate over.

Sources:
  - NSE archive CSV (public, no auth): EQUITY_L.csv -> ~2000 NSE-listed stocks
  - BSE list (api.bseindia.com) -> BSE codes for cross-reference

Run once. Re-run monthly to pick up new listings.

Usage:
  python fetch_universe.py
  python fetch_universe.py --out universe.csv
"""
import argparse, csv, io, sys, time
import httpx

NSE_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"
BSE_URL = "https://api.bseindia.com/BseIndiaAPI/api/ListofScripCode/w?segment=Equity&status=Active"
SCREENER_SITEMAP = "https://www.screener.in/sitemap-companies.xml"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

def fetch_nse(client):
    r = client.get(NSE_URL, headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    rows = list(csv.DictReader(io.StringIO(r.text)))
    out = []
    for r in rows:
        sym = r.get("SYMBOL", "").strip()
        name = r.get("NAME OF COMPANY", "").strip()
        isin = r.get(" ISIN NUMBER", r.get("ISIN NUMBER", "")).strip()
        if sym:
            out.append({"nse_symbol": sym, "name": name, "isin": isin})
    return out

def fetch_screener_sitemap(client):
    """Returns list of {slug, is_bse_code} from screener's company sitemap."""
    import re
    try:
        r = client.get(SCREENER_SITEMAP, headers={"User-Agent": UA}, timeout=60)
        r.raise_for_status()
    except Exception as e:
        print(f"WARN: screener sitemap fetch failed ({e}).", file=sys.stderr)
        return []
    locs = re.findall(r"<loc>https://www\.screener\.in/company/([^/<]+)/?[^<]*</loc>", r.text)
    out = []
    seen = set()
    for slug in locs:
        if slug in seen:
            continue
        seen.add(slug)
        is_bse_code = slug.isdigit()
        out.append({"slug": slug, "is_bse_code": is_bse_code})
    return out


def fetch_bse(client):
    headers = {
        "User-Agent": UA,
        "Referer": "https://www.bseindia.com/",
        "Accept": "application/json",
    }
    try:
        r = client.get(BSE_URL, headers=headers, timeout=30)
        r.raise_for_status()
        data = r.json()
        rows = data if isinstance(data, list) else data.get("Table", [])
        out = {}
        for row in rows:
            isin = (row.get("ISIN_NUMBER") or "").strip()
            code = (row.get("SCRIP_CD") or row.get("Scrip_Cd") or "").strip()
            name = (row.get("Issuer_Name") or row.get("scrip_name") or "").strip()
            if isin and code:
                out[isin] = {"bse_code": code, "name": name}
        return out
    except Exception as e:
        print(f"WARN: BSE fetch failed ({e}). Continuing with NSE only.", file=sys.stderr)
        return {}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="universe.csv")
    args = ap.parse_args()

    with httpx.Client(http2=False, follow_redirects=True) as client:
        print("Fetching NSE EQUITY list...")
        nse = fetch_nse(client)
        print(f"  {len(nse)} NSE rows")
        time.sleep(1)
        print("Fetching BSE active scrips...")
        bse_by_isin = fetch_bse(client)
        print(f"  {len(bse_by_isin)} BSE rows (by ISIN)")
        time.sleep(1)
        print("Fetching screener sitemap...")
        sitemap = fetch_screener_sitemap(client)
        print(f"  {len(sitemap)} screener URLs ({sum(1 for s in sitemap if s['is_bse_code'])} BSE-code slugs)")

    # Merge: prefer NSE symbol, attach BSE code via ISIN
    rows = []
    for n in nse:
        bse = bse_by_isin.get(n["isin"], {})
        rows.append({
            "tv_symbol": f"NSE:{n['nse_symbol']}",
            "screener_slug": n["nse_symbol"],   # screener URL uses NSE symbol
            "bse_code": bse.get("bse_code", ""),
            "isin": n["isin"],
            "name": n["name"],
        })

    # Add BSE-only stocks (no NSE listing) via BSE-by-ISIN
    seen_isins = {n["isin"] for n in nse if n["isin"]}
    for isin, bse in bse_by_isin.items():
        if isin in seen_isins:
            continue
        rows.append({
            "tv_symbol": f"BSE:{bse['bse_code']}",
            "screener_slug": bse["bse_code"],
            "bse_code": bse["bse_code"],
            "isin": isin,
            "name": bse["name"],
        })

    # Add BSE-only stocks via screener sitemap (covers cases BSE API blocked).
    # If slug is purely numeric AND not already in our universe, add it.
    existing_slugs = {r["screener_slug"] for r in rows}
    for entry in sitemap:
        slug = entry["slug"]
        if slug in existing_slugs:
            continue
        if entry["is_bse_code"]:
            rows.append({
                "tv_symbol": f"BSE:{slug}",
                "screener_slug": slug,
                "bse_code": slug,
                "isin": "",
                "name": "",  # filled by scraper from screener page
            })
        else:
            # NSE-style slug from screener that wasn't in NSE archive (delisted/renamed?)
            rows.append({
                "tv_symbol": f"NSE:{slug}",
                "screener_slug": slug,
                "bse_code": "",
                "isin": "",
                "name": "",
            })
        existing_slugs.add(slug)

    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["tv_symbol", "screener_slug", "bse_code", "isin", "name"])
        w.writeheader()
        w.writerows(rows)

    print(f"Wrote {len(rows)} rows to {args.out}")

if __name__ == "__main__":
    main()
