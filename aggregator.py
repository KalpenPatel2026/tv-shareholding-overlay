"""
Merge ShareholdingData from multiple providers into one final record using
priority chains. For each metric, walk the priority list and take the first
provider that returned a non-empty series. Tag each cell with its source so
the UI can show where the number came from.

If two adjacent providers both have data and disagree by more than a
configurable tolerance for the latest period, log a warning to the audit
column. The aggregator never silently overwrites with a "wrong" value —
the priority list is the policy.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Iterable
from sources.base import ShareholdingData, Point, period_key

# Default per-metric provider priority. Override via --priority CLI flag.
DEFAULT_PRIORITY = {
    # BSE provider currently disabled by default - their public API now SPA-renders.
    # Tickertape primary for pledge (screener no longer publishes pledge publicly,
    # not even on Pro tier). Tickertape coverage limited to last ~6 quarters.
    "promoter_q":  ["screener_pro", "screener_public", "tickertape"],
    "pledge_q":    ["tickertape", "screener_pro"],
    "promoter_fy": ["screener_pro", "screener_public", "tickertape"],
    "pledge_fy":   ["tickertape", "screener_pro"],
    "rpt_fy":      ["screener_pro"],
}


def merge(records: Iterable[ShareholdingData], priority=DEFAULT_PRIORITY) -> dict:
    """Returns a dict matching the data.json stock-record shape."""
    by_source = {r.source: r for r in records}
    out = {
        "promoter_q": [], "pledge_q": [],
        "promoter_fy": [], "pledge_fy": [],
        "rpt_fy": [],
        "sources_used": {},   # metric -> source name
        "audit": [],          # list of human-readable notes
    }

    for metric, chain in priority.items():
        chosen_src = None
        for src in chain:
            r = by_source.get(src)
            if not r:
                continue
            series = getattr(r, metric, None) or []
            if series:
                # Sort newest-first defensively
                series = sorted(series, key=lambda pt: period_key(pt.p), reverse=True)
                out[metric] = [{"p": pt.p, "v": pt.v, "src": pt.src} for pt in series]
                chosen_src = src
                break
        out["sources_used"][metric] = chosen_src or None

        # Cross-source agreement check on latest period
        if chosen_src and len(chain) > 1:
            chosen_series = getattr(by_source[chosen_src], metric)
            for other in chain:
                if other == chosen_src:
                    continue
                r2 = by_source.get(other)
                if not r2:
                    continue
                s2 = getattr(r2, metric, None) or []
                if not s2 or not chosen_series:
                    continue
                # Compare first period (by period_key match) between the two
                map2 = {pt.p: pt.v for pt in s2}
                for pt in chosen_series[:1]:
                    if pt.v is None:
                        continue
                    other_v = map2.get(pt.p)
                    if other_v is None:
                        # try fuzzy period match
                        for k, v in map2.items():
                            if period_key(k) == period_key(pt.p):
                                other_v = v
                                break
                    if other_v is not None and abs(other_v - pt.v) > 0.5:
                        out["audit"].append(
                            f"{metric} disagreement on {pt.p}: "
                            f"{chosen_src}={pt.v} vs {other}={other_v}"
                        )
    return out
