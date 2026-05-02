"""
Tickertape source — primary pledge-percentage provider.

Uses Tickertape's public JSON API:
    https://api.tickertape.in/stocks/holdings/{sid}
which returns the last 6 quarterly shareholding snapshots.

Key fields (per snapshot):
    pmPctT   = Promoter %, of total shares
    pmPctP   = Pledged %, of promoter holding   <- this is "Pledge %"
    plPctT   = Pledged %, of total shares
    uPlPctT  = Unpledged Promoter %, of total
    fiPctT   = FII %
    diPctT   = DII %

We store pmPctP into pledge_q (matches Indian convention "X% of promoter shares
pledged"). Promoter holding from this source goes into promoter_q as a
secondary fallback only — screener_pro is preferred when available.

Limitation: Tickertape only exposes the most recent 6 quarters (~1.5 years).
For longer history, extend with BSE XBRL parsing in a future provider.
"""
from __future__ import annotations
import datetime as _dt
import httpx
from .base import Provider, ShareholdingData, Point


class Tickertape(Provider):
    name = "tickertape"
    needs_auth = False
    BASE = "https://api.tickertape.in"
    LIST = BASE + "/stocks/list"
    HOLDINGS = BASE + "/stocks/holdings/{sid}"

    # class-level cache shared across all instances within a run
    _ticker_to_sid = None

    def _hdrs(self):
        return {
            "User-Agent": self.UA,
            "Accept": "application/json",
            "Origin": "https://www.tickertape.in",
            "Referer": "https://www.tickertape.in/",
            "Accept-Language": "en-US,en",
        }

    def _build_map(self):
        if Tickertape._ticker_to_sid is not None:
            return
        try:
            r = self.client.get(self.LIST, headers=self._hdrs(), timeout=30)
            if r.status_code != 200:
                Tickertape._ticker_to_sid = {}
                return
            data = r.json()
            arr = data.get("data") if isinstance(data, dict) else data
            mapping = {}
            for row in arr or []:
                t = (row.get("ticker") or "").upper()
                sid = row.get("sid")
                if t and sid:
                    mapping[t] = sid
            Tickertape._ticker_to_sid = mapping
        except Exception:
            Tickertape._ticker_to_sid = {}

    def _resolve_sid(self, nse_symbol: str):
        self._build_map()
        return Tickertape._ticker_to_sid.get(nse_symbol.upper())

    def fetch(self, row) -> ShareholdingData:
        out = ShareholdingData(source=self.name)
        # Tickertape has NSE coverage only; BSE-only stocks won't resolve.
        nse = None
        if row.get("tv_symbol", "").startswith("NSE:"):
            nse = row["tv_symbol"].split(":", 1)[1]
        else:
            slug = row.get("screener_slug", "")
            if slug and not slug.isdigit():
                nse = slug.upper()
        if not nse:
            out.err = "no nse symbol"
            return out

        sid = self._resolve_sid(nse)
        if not sid:
            out.err = f"sid not found for {nse}"
            return out

        try:
            r = self.client.get(self.HOLDINGS.format(sid=sid),
                                headers=self._hdrs(), timeout=15)
            if r.status_code != 200:
                out.err = f"holdings http {r.status_code}"
                return out
            try:
                j = r.json()
            except ValueError:
                out.err = "holdings non-json"
                return out
        except (httpx.HTTPError, ValueError) as e:
            out.err = str(e)
            return out

        rows = j.get("data") or []
        if not rows:
            out.err = "empty holdings array"
            return out

        prom_q, pledge_q = [], []
        for entry in rows:
            iso = entry.get("date")
            d = entry.get("data") or {}
            if not iso or not isinstance(d, dict):
                continue
            try:
                dt = _dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
            except Exception:
                continue
            label = dt.strftime("%b %Y")  # "Mar 2025"

            prom_v = d.get("pmPctT")
            if prom_v is not None:
                prom_q.append(Point(p=label, v=round(float(prom_v), 2), src=self.name))
            pledge_v = d.get("pmPctP")
            if pledge_v is not None:
                pledge_q.append(Point(p=label, v=round(float(pledge_v), 2), src=self.name))

        # Newest-first
        prom_q.sort(key=lambda pt: pt.p, reverse=True)
        pledge_q.sort(key=lambda pt: pt.p, reverse=True)

        # Build FY series from quarterly: FY ends Mar; pick Mar entry of each year
        prom_fy, pledge_fy = [], []
        for pt in prom_q:
            if pt.p.startswith("Mar "):
                year = pt.p.split()[1]
                fy_label = f"FY{year[-2:]}"
                prom_fy.append(Point(p=fy_label, v=pt.v, src=self.name))
        for pt in pledge_q:
            if pt.p.startswith("Mar "):
                year = pt.p.split()[1]
                fy_label = f"FY{year[-2:]}"
                pledge_fy.append(Point(p=fy_label, v=pt.v, src=self.name))

        out.promoter_q = prom_q
        out.pledge_q = pledge_q
        out.promoter_fy = prom_fy
        out.pledge_fy = pledge_fy
        return out
