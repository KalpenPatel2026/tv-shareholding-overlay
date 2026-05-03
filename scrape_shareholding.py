"""
Multi-source shareholding scraper.

For each stock in universe.csv:
  1. Query every enabled provider in parallel-ish (sequential with delay).
  2. Merge the responses with priority chains defined in aggregator.py.
  3. Write the merged record + per-metric source attribution to extension/data.json.

Auth:
  Place cookie / API keys in .secrets/ if you want Pro-tier sources active.
  See .secrets/README.md for the cookie export procedure.

Usage:
  python scrape_shareholding.py                        full universe
  python scrape_shareholding.py --symbols RELIANCE,TCS just these
  python scrape_shareholding.py --max 50               first 50 (debug)
  python scrape_shareholding.py --resume               skip stocks already in data.json
  python scrape_shareholding.py --providers screener_public,bse  override defaults
  python scrape_shareholding.py --no-pro               skip screener_pro even if cookie present
"""
from __future__ import annotations
import argparse, csv, datetime, json, pathlib, sys, time, traceback
import httpx

# Add this dir to sys.path so 'sources' imports work when run as script
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from sources import (Provider, ScreenerPublic, ScreenerPro, Tickertape, BSEFilings)
from aggregator import merge, DEFAULT_PRIORITY

UNIVERSE = HERE / "universe.csv"
OUT = HERE / "extension" / "data.json"

# Provider registry
ALL_PROVIDERS = {
    "screener_public": ScreenerPublic,
    "screener_pro":    ScreenerPro,
    "tickertape":      Tickertape,
    "bse":             BSEFilings,
}


def build_providers(client, names: list[str], settings: dict) -> list[Provider]:
    out = []
    for n in names:
        cls = ALL_PROVIDERS.get(n)
        if not cls:
            print(f"unknown provider: {n}", file=sys.stderr)
            continue
        p = cls(client, settings)
        if not p.enabled:
            print(f"  [skip] {n}: disabled "
                  f"({'no cookie' if p.needs_auth else 'unavailable'})",
                  file=sys.stderr)
            continue
        out.append(p)
    return out


def scrape_one(row, providers: list[Provider], delay: float) -> dict | None:
    records = []
    errs = []
    for i, p in enumerate(providers):
        try:
            rec = p.fetch(row)
            if rec.err:
                errs.append(f"{p.name}: {rec.err}")
            records.append(rec)
        except Exception as e:
            errs.append(f"{p.name}: exception {e}")
            traceback.print_exc(file=sys.stderr)
        # Sleep only between providers, not after the last one (saves N delays per stock)
        if i < len(providers) - 1:
            time.sleep(delay)

    merged = merge(records)
    has_data = any(merged[k] for k in
                   ("promoter_q", "promoter_fy", "pledge_q", "pledge_fy",
                    "rpt_fy", "rpt_sales_fy", "rpt_purchases_fy", "rpt_loans_fy"))
    if not has_data:
        return None

    tv_syms = [row["tv_symbol"]]
    if row.get("bse_code") and not row["tv_symbol"].startswith("BSE:"):
        tv_syms.append(f"BSE:{row['bse_code']}")

    return {
        "tv_symbols": tv_syms,
        "name": row.get("name", ""),
        "promoter_q": merged["promoter_q"],
        "pledge_q": merged["pledge_q"],
        "promoter_fy": merged["promoter_fy"],
        "pledge_fy": merged["pledge_fy"],
        "rpt_fy": merged["rpt_fy"],
        "rpt_sales_fy": merged["rpt_sales_fy"],
        "rpt_purchases_fy": merged["rpt_purchases_fy"],
        "rpt_loans_fy": merged["rpt_loans_fy"],
        "sources_used": merged["sources_used"],
        "audit": merged["audit"],
        "errors": errs,
    }


def load_universe(path):
    return list(csv.DictReader(open(path, encoding="utf-8")))


def write_atomic(path: pathlib.Path, obj):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    tmp.replace(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default=str(UNIVERSE))
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--symbols", help="Comma-separated symbol slugs to scrape")
    ap.add_argument("--max", type=int, default=None)
    ap.add_argument("--delay", type=float, default=1.5,
                    help="Seconds between provider requests (per stock).")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--providers", default="screener_pro,tickertape",
                    help="Comma-separated providers to enable, in priority order.")
    ap.add_argument("--no-pro", action="store_true",
                    help="Skip screener_pro even if cookie present.")
    args = ap.parse_args()

    if not pathlib.Path(args.universe).exists():
        print(f"universe.csv missing at {args.universe}. Run fetch_universe.py first.",
              file=sys.stderr)
        sys.exit(1)

    rows = load_universe(args.universe)
    if args.symbols:
        wanted = {s.strip().upper() for s in args.symbols.split(",")}
        rows = [r for r in rows
                if r["screener_slug"].upper() in wanted
                or r["tv_symbol"].split(":")[-1].upper() in wanted]
    if args.max:
        rows = rows[: args.max]

    out_path = pathlib.Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    existing = {}
    if args.resume and out_path.exists():
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8")).get("stocks", {})
        except Exception:
            existing = {}

    settings = {}
    provider_names = [n.strip() for n in args.providers.split(",") if n.strip()]
    if args.no_pro and "screener_pro" in provider_names:
        provider_names.remove("screener_pro")

    result = {
        "as_of": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds")
                 .replace("+00:00", "Z"),
        "stocks": dict(existing),
        "by_tv": {},
    }

    with httpx.Client(http2=False, follow_redirects=True) as client:
        providers = build_providers(client, provider_names, settings)
        print(f"Active providers: {[p.name for p in providers]}")
        if not providers:
            print("No active providers. Exiting.", file=sys.stderr)
            sys.exit(2)

        ok = miss = skip = 0
        for i, row in enumerate(rows, 1):
            slug = row["screener_slug"]
            if args.resume and slug in result["stocks"]:
                skip += 1
                continue
            try:
                rec = scrape_one(row, providers, args.delay)
                if rec:
                    result["stocks"][slug] = rec
                    sources = " ".join(
                        f"{m}={s or '-'}" for m, s in rec["sources_used"].items()
                    )
                    print(f"[{i}/{len(rows)}] OK   {slug}  ({sources})")
                    ok += 1
                else:
                    print(f"[{i}/{len(rows)}] MISS {slug}", file=sys.stderr)
                    miss += 1
            except Exception as e:
                print(f"[{i}/{len(rows)}] FAIL {slug}: {e}", file=sys.stderr)
                miss += 1

            if i % 25 == 0:
                _index_and_write(result, out_path)

    _index_and_write(result, out_path)
    print(f"\nDone. ok={ok} miss={miss} skip={skip}  ->  {out_path}")


def _index_and_write(result, out_path):
    by_tv = {}
    for slug, rec in result["stocks"].items():
        for tv in rec.get("tv_symbols", []):
            by_tv[tv] = slug
    result["by_tv"] = by_tv
    write_atomic(out_path, result)


if __name__ == "__main__":
    main()
