"""
screener.in Pro-tier scraper. Reuses the public scraper for promoter holding
(same HTML), then additionally pulls:
  - Pledge % (Pro tier shows the row inside expanded Promoters block)
  - Related Party Transactions / Sales % (Pro: full schedules API)

Auth: reads cookie from .secrets/screener_cookie.txt
File format: a single line of the cookie header, e.g.
    sessionid=abcd1234; csrftoken=wxyz5678
Or just the session value:
    abcd1234
"""
from __future__ import annotations
import json, pathlib, re, httpx
from bs4 import BeautifulSoup
from .base import Provider, ShareholdingData, Point, period_key

HERE = pathlib.Path(__file__).resolve().parent.parent
COOKIE_FILE = HERE / ".secrets" / "screener_cookie.txt"


def _load_cookie() -> str | None:
    if not COOKIE_FILE.exists():
        return None
    raw = COOKIE_FILE.read_text(encoding="utf-8").strip()
    if not raw:
        return None
    # If user pasted only the session value, wrap it
    if "=" not in raw:
        return f"sessionid={raw}"
    return raw


class ScreenerPro(Provider):
    name = "screener_pro"
    needs_auth = True
    BASE = "https://www.screener.in"

    def __init__(self, client, settings):
        super().__init__(client, settings)
        self.cookie = _load_cookie()
        self.enabled = bool(self.cookie)

    def _headers(self):
        h = {
            "User-Agent": self.UA,
            "Accept-Language": "en-US,en",
            "Referer": self.BASE + "/",
        }
        if self.cookie:
            h["Cookie"] = self.cookie
        return h

    def _get(self, url):
        r = self.client.get(url, headers=self._headers(), timeout=30, follow_redirects=True)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.text

    def fetch(self, row) -> ShareholdingData:
        slug = row["screener_slug"]
        out = ShareholdingData(source=self.name)
        html = None
        for path in (f"/company/{slug}/consolidated/", f"/company/{slug}/"):
            try:
                html = self._get(self.BASE + path)
                if html:
                    break
            except httpx.HTTPError as e:
                out.err = f"{e}"
        if not html:
            out.err = out.err or "page not reachable"
            return out

        soup = BeautifulSoup(html, "lxml")
        self._parse_shareholding(soup, out)

        # Company id for RPT page
        cid_tuple = self._company_id(soup, html)
        if cid_tuple and cid_tuple[0]:
            self._parse_rpt(soup, cid_tuple, out)
        return out

    # ---------- shareholding (promoter + pledge) ----------

    def _parse_shareholding(self, soup, out: ShareholdingData):
        sec = soup.find("section", id="shareholding")
        if not sec:
            return

        for sub_id, prom_attr, pledge_attr in (
            ("quarterly-shp", "promoter_q", "pledge_q"),
            ("yearly-shp", "promoter_fy", "pledge_fy"),
        ):
            div = sec.find(id=sub_id)
            if not div:
                continue
            table = div.find("table")
            if not table:
                continue
            thead = table.find("thead")
            if not thead:
                continue
            periods = [th.get_text(strip=True) for th in thead.find_all("th")[1:]]
            tbody = table.find("tbody")
            if not tbody:
                continue
            # Pro: rows for "Promoters +" plus expandable nested rows incl. "Pledged"
            for tr in tbody.find_all("tr"):
                tds = tr.find_all("td")
                if not tds:
                    continue
                label = tds[0].get_text(" ", strip=True).rstrip("+").lower()
                values = [self.num(td.get_text(strip=True)) for td in tds[1:]]
                paired = list(zip(periods, values))
                paired.reverse()  # newest first
                if "pledge" in label or "encumber" in label:
                    setattr(out, pledge_attr,
                            [Point(p=p, v=v, src=self.name) for p, v in paired])
                elif "promoter" in label and "non-promoter" not in label:
                    setattr(out, prom_attr,
                            [Point(p=p, v=v, src=self.name) for p, v in paired])

    # ---------- RPT/Sales ----------

    def _company_id(self, soup, html):
        # Pro page exposes id via the RPT button data-url: /results/rpt/{id}/...
        m = re.search(r'/results/rpt/(\d+)/', html)
        if m:
            return m.group(1), ("consolidated" if "/results/rpt/" in html and "consolidated" in html else "standalone")
        # Fallbacks
        for sel in [
            ("div", {"data-warehouse-id": True}, "data-warehouse-id"),
            ("a",   {"data-warehouse-id": True}, "data-warehouse-id"),
        ]:
            tag, attrs, key = sel
            el = soup.find(tag, attrs=attrs)
            if el:
                return el.get(key), "consolidated"
        m = re.search(r'company[_-]id["\']?\s*[:=]\s*["\']?(\d{3,8})', html)
        return (m.group(1), "consolidated") if m else (None, None)

    # ---- RPT line classifier (Vijay-Malik framework) ----
    # Map keyword -> bucket. Order matters: first match wins.
    _RPT_RULES = [
        # Capital flows (loans / advances / investments to RP)
        ("loans",     ["loan given", "loan granted", "loans to", "loan to",
                        "advance given", "advances given", "advances to",
                        "investment in", "investments in", "deposit given",
                        "deposits given", "icd given", "inter-corporate deposit"]),
        # Inflows from RP — IGNORE (loan repaid, dividend received etc) — bucket 'ignore'
        ("ignore",    ["loan repaid", "loan recovered", "advance recovered",
                        "advance returned", "dividend received", "dividend income",
                        "interest received", "loan taken", "loan accepted",
                        "borrowing", "outstanding", "balance as at",
                        "receivable", "payable", "guarantee given",
                        "guarantee received", "closing balance", "opening balance"]),
        # Sales-side (revenue from RP)
        ("sales",     ["sale of goods", "sale of services", "sales to",
                        "revenue from", "income from", "services rendered",
                        "rendering of services", "fees received", "commission received",
                        "rent received", "royalty received", "sale of "]),
        # Purchase-side (everything paid out)
        ("purchases", ["purchase of goods", "purchase of services", "purchases from",
                        "purchase of", "expense", "fuel", "power", "water",
                        "raw material", "materials consumed", "service availed",
                        "services received", "rent paid", "royalty paid",
                        "salary", "remuneration", "managerial remuneration",
                        "reimbursement", "fees paid", "commission paid",
                        "contribution to", "interest paid", "interest expense",
                        "professional fees", "consultancy", "legal", "audit fee",
                        "directors sitting", "stipend", "bonus"]),
    ]

    @classmethod
    def _classify(cls, label: str) -> str:
        s = label.lower()
        for bucket, kws in cls._RPT_RULES:
            for kw in kws:
                if kw in s:
                    return bucket
        # Default: anything unclassified treat as purchase (conservative — most are expenses)
        return "purchases"

    def _parse_rpt(self, soup, cid_tuple, out: ShareholdingData):
        # Screener Pro RPT page: /results/rpt/{id}/consolidated/
        # Rows = (related party, transaction type), columns = fiscal years.
        # We classify each transaction-type row into sales / purchases / loans
        # buckets and compute three separate ratios.
        cid, mode = cid_tuple if isinstance(cid_tuple, tuple) else (cid_tuple, "consolidated")
        if not cid:
            return
        rpt_html = None
        for path in (f"/results/rpt/{cid}/consolidated/",
                     f"/results/rpt/{cid}/"):
            try:
                rpt_html = self._get(self.BASE + path)
                if rpt_html and "data-table" in rpt_html:
                    break
            except httpx.HTTPError:
                continue
        if not rpt_html:
            return

        rs = BeautifulSoup(rpt_html, "lxml")
        table = rs.find("table", class_="data-table") or rs.find("table")
        if not table:
            return
        thead = table.find("thead")
        if not thead:
            return
        ths = thead.find_all("th")
        periods = [th.get_text(strip=True) for th in ths[1:]]

        # bucket sums per period
        sales_by_p     = {p: 0.0 for p in periods}
        purchases_by_p = {p: 0.0 for p in periods}
        loans_by_p     = {p: 0.0 for p in periods}
        total_by_p     = {p: 0.0 for p in periods}   # legacy aggregate

        tbody = table.find("tbody")
        if not tbody:
            return
        for tr in tbody.find_all("tr"):
            tds = tr.find_all("td")
            if not tds or len(tds) < 2:
                continue
            # Heading rows (related-party name) have colspan and no values
            if len(tds) == 2 and tds[1].get("colspan"):
                continue
            label = tds[0].get_text(" ", strip=True)
            bucket = self._classify(label)
            if bucket == "ignore":
                continue
            for i, td in enumerate(tds[1:]):
                if i >= len(periods):
                    break
                v = self.num(td.get_text(strip=True))
                if v is None or v == 0:
                    continue
                a = abs(v)
                total_by_p[periods[i]] += a
                if bucket == "sales":
                    sales_by_p[periods[i]] += a
                elif bucket == "purchases":
                    purchases_by_p[periods[i]] += a
                elif bucket == "loans":
                    loans_by_p[periods[i]] += a

        # Pull Revenue + Equity from main page
        rev_by_p, equity_by_p = {}, {}
        pnl = soup.find("section", id="profit-loss")
        if pnl:
            table2 = pnl.find("table")
            if table2 and table2.find("thead") and table2.find("tbody"):
                p_periods = [th.get_text(strip=True)
                             for th in table2.find("thead").find_all("th")[1:]]
                for tr in table2.find("tbody").find_all("tr"):
                    tds = tr.find_all("td")
                    if not tds: continue
                    label = tds[0].get_text(" ", strip=True).rstrip("+").lower()
                    if label.startswith("sales") or label.startswith("revenue"):
                        vals = [self.num(td.get_text(strip=True)) for td in tds[1:]]
                        for p, v in zip(p_periods, vals):
                            rev_by_p[p] = v
                        break

        bs = soup.find("section", id="balance-sheet")
        if bs:
            table3 = bs.find("table")
            if table3 and table3.find("thead") and table3.find("tbody"):
                b_periods = [th.get_text(strip=True)
                             for th in table3.find("thead").find_all("th")[1:]]
                eq_capital = {p: None for p in b_periods}
                reserves = {p: None for p in b_periods}
                for tr in table3.find("tbody").find_all("tr"):
                    tds = tr.find_all("td")
                    if not tds: continue
                    label = tds[0].get_text(" ", strip=True).rstrip("+").lower()
                    vals = [self.num(td.get_text(strip=True)) for td in tds[1:]]
                    if "equity capital" in label or label == "share capital":
                        for p, v in zip(b_periods, vals):
                            eq_capital[p] = v
                    elif label.startswith("reserves"):
                        for p, v in zip(b_periods, vals):
                            reserves[p] = v
                for p in b_periods:
                    a, b = eq_capital.get(p), reserves.get(p)
                    if a is not None or b is not None:
                        equity_by_p[p] = (a or 0) + (b or 0)

        # Build series newest-first
        out.rpt_fy = []
        out.rpt_sales_fy = []
        out.rpt_purchases_fy = []
        out.rpt_loans_fy = []
        for p in sorted(periods, key=period_key, reverse=True):
            rev = rev_by_p.get(p)
            equity = equity_by_p.get(p)
            tot = total_by_p[p]
            sl = sales_by_p[p]
            pu = purchases_by_p[p]
            ln = loans_by_p[p]
            if tot == 0 and ln == 0:
                continue

            def ratio(num, denom):
                if num and denom and denom > 0:
                    return round(100.0 * num / denom, 2)
                return None

            if tot:
                out.rpt_fy.append(Point(p=p, v=ratio(tot, rev), src=self.name))
            if sl:
                out.rpt_sales_fy.append(Point(p=p, v=ratio(sl, rev), src=self.name))
            if pu:
                out.rpt_purchases_fy.append(Point(p=p, v=ratio(pu, rev), src=self.name))
            if ln:
                out.rpt_loans_fy.append(Point(p=p, v=ratio(ln, equity), src=self.name))
