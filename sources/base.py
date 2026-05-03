"""
Common types + abstract Provider class for shareholding-data sources.

Each source returns a ShareholdingData object with whatever metrics it can
populate. The aggregator then merges across sources using a priority chain
defined per-metric.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
import re


@dataclass
class Point:
    """One period's value for one metric, tagged with source."""
    p: str            # "Mar 2025" / "FY25" / "Sep 2025"
    v: Optional[float]
    src: str          # source name, e.g. "screener_pro"


# A Series is just a list of Points, newest-first
Series = list


@dataclass
class ShareholdingData:
    """All the metrics one source can return for one stock."""
    source: str
    promoter_q: Series = field(default_factory=list)
    pledge_q: Series = field(default_factory=list)
    promoter_fy: Series = field(default_factory=list)
    pledge_fy: Series = field(default_factory=list)
    rpt_fy: Series = field(default_factory=list)         # legacy aggregate (deprecated; kept for fallback)
    rpt_sales_fy: Series = field(default_factory=list)    # Sales-to-RP / Total revenue (%)
    rpt_purchases_fy: Series = field(default_factory=list)  # Purchases-from-RP / Total revenue (%)
    rpt_loans_fy: Series = field(default_factory=list)    # Loans+investments-to-RP / Net worth (%)
    err: Optional[str] = None      # populated if fetch failed

    def is_empty(self) -> bool:
        return not (self.promoter_q or self.promoter_fy
                    or self.pledge_q or self.pledge_fy
                    or self.rpt_fy or self.rpt_sales_fy
                    or self.rpt_purchases_fy or self.rpt_loans_fy)


class Provider:
    """Abstract base. Subclasses implement fetch()."""
    name: str = "base"
    # When True, provider needs an auth cookie/key from .secrets/
    needs_auth: bool = False
    # Set False to skip globally (e.g. if cookie missing for an auth source)
    enabled: bool = True

    def __init__(self, client, settings: dict):
        self.client = client
        self.settings = settings

    def fetch(self, row: dict) -> ShareholdingData:
        """row is one universe.csv record; return ShareholdingData."""
        raise NotImplementedError

    # --- helpers reusable across providers ---

    UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/120 Safari/537.36")

    @staticmethod
    def num(s):
        if s is None:
            return None
        s = str(s).strip().replace("%", "").replace(",", "")
        if s in ("", "-", "—", "NA", "N/A"):
            return None
        s = re.sub(r"[^\d\.\-]", "", s)
        try:
            return float(s)
        except ValueError:
            return None


def period_key(p: str):
    """Sort key for periods: 'Mar 2025', 'FY25', 'Q3FY26', 'Sep 2025'."""
    p = p.strip()
    # FYxx
    m = re.match(r"FY(\d{2,4})", p, re.IGNORECASE)
    if m:
        y = int(m.group(1))
        if y < 100: y += 2000
        return (y, 12)
    # Quarter forms: 'Sep 2025' / 'Mar 2026'
    mon_map = dict(jan=1, feb=2, mar=3, apr=4, may=5, jun=6,
                   jul=7, aug=8, sep=9, oct=10, nov=11, dec=12)
    mon = 0
    for k, v in mon_map.items():
        if k in p.lower():
            mon = v
            break
    m = re.search(r"(\d{2,4})", p)
    if m:
        y = int(m.group(1))
        if y < 100: y += 2000
        return (y, mon or 12)
    return (0, 0)
