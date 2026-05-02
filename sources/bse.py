"""
BSE corporate filings source — authoritative for pledge %.

BSE publishes shareholding pattern XBRL filings every quarter. Public.
Endpoint:  https://api.bseindia.com/BseIndiaAPI/api/ShpQtrlyHldng/w?scripcd={code}

Returns a list of quarterly filings with totals; one nested row carries
"Promoter and promoter group total" (= promoter%) and another gives the
"Total pledged shares" / "Promoters' shares pledged or otherwise encumbered" %.

Requires the BSE scrip code (numeric, in universe.csv).
"""
from __future__ import annotations
import httpx
from .base import Provider, ShareholdingData, Point


class BSEFilings(Provider):
    name = "bse"
    needs_auth = False
    API = "https://api.bseindia.com/BseIndiaAPI/api/ShpQtrlyHldng/w?scripcd={code}"

    def _headers(self):
        return {
            "User-Agent": self.UA,
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://www.bseindia.com",
            "Referer": "https://www.bseindia.com/",
            "Accept-Language": "en-US,en",
        }

    def fetch(self, row) -> ShareholdingData:
        out = ShareholdingData(source=self.name)
        code = (row.get("bse_code") or "").strip()
        if not code or not code.isdigit():
            out.err = "no bse_code"
            return out
        try:
            r = self.client.get(self.API.format(code=code),
                                headers=self._headers(), timeout=30)
            if r.status_code != 200:
                out.err = f"http {r.status_code}"
                return out
            try:
                data = r.json()
            except Exception:
                out.err = "non-json response"
                return out
        except httpx.HTTPError as e:
            out.err = str(e)
            return out

        # Schema observed in mid-2025: { Table: [ { QtrEnd, prom%, pledge%, ... }, ... ] }
        rows = data.get("Table") if isinstance(data, dict) else None
        if not rows:
            out.err = "no Table key"
            return out

        prom, pledge = [], []
        for r in rows:
            if not isinstance(r, dict):
                continue
            p = r.get("QtrEnd") or r.get("Qtr_End") or r.get("Date")
            promoter_v = self.num(
                r.get("PromHldShPer") or r.get("Promoter_Holding_Percentage")
                or r.get("PromHld") or r.get("PromShPer")
            )
            pledge_v = self.num(
                r.get("PromPledgedShPer") or r.get("Pledge_Pct")
                or r.get("Pledged_Pct") or r.get("PromShPledgedPer")
            )
            if not p:
                continue
            if promoter_v is not None:
                prom.append(Point(p=str(p), v=promoter_v, src=self.name))
            if pledge_v is not None:
                pledge.append(Point(p=str(p), v=pledge_v, src=self.name))

        # Newest-first
        prom.sort(key=lambda x: x.p, reverse=True)
        pledge.sort(key=lambda x: x.p, reverse=True)
        out.promoter_q = prom
        out.pledge_q = pledge
        return out
