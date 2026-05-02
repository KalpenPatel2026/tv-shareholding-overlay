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

    def _parse_rpt(self, soup, cid_tuple, out: ShareholdingData):
        # New (2025+) screener Pro RPT page: /results/rpt/{id}/consolidated/
        # Returns full HTML table: rows = (related party, transaction type),
        # columns = fiscal years.
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
        # First TH is empty (party name col); rest are periods like "Mar 2025"
        periods = [th.get_text(strip=True) for th in ths[1:]]
        rpt_by_p = {p: 0.0 for p in periods}
        any_value = False

        tbody = table.find("tbody")
        if not tbody:
            return
        for tr in tbody.find_all("tr"):
            tds = tr.find_all("td")
            if not tds or len(tds) < 2:
                continue
            # Heading rows have a single colspan'd cell — skip
            if len(tds) == 2 and tds[1].get("colspan"):
                continue
            # Sum absolute values across all party-rows
            for i, td in enumerate(tds[1:]):
                if i >= len(periods):
                    break
                v = self.num(td.get_text(strip=True))
                if v is not None and v != 0:
                    rpt_by_p[periods[i]] += abs(v)
                    any_value = True

        if not any_value:
            return

        # Revenue from main P&L on the company page
        rev_by_p = {}
        pnl = soup.find("section", id="profit-loss")
        if pnl:
            table2 = pnl.find("table")
            if table2 and table2.find("thead") and table2.find("tbody"):
                p_periods = [th.get_text(strip=True)
                             for th in table2.find("thead").find_all("th")[1:]]
                for tr in table2.find("tbody").find_all("tr"):
                    tds = tr.find_all("td")
                    if not tds:
                        continue
                    label = tds[0].get_text(" ", strip=True).rstrip("+").lower()
                    if label.startswith("sales") or label.startswith("revenue"):
                        vals = [self.num(td.get_text(strip=True)) for td in tds[1:]]
                        for p, v in zip(p_periods, vals):
                            rev_by_p[p] = v
                        break

        out.rpt_fy = []
        for p in sorted(rpt_by_p.keys(), key=period_key, reverse=True):
            total = rpt_by_p[p]
            rev = rev_by_p.get(p)
            if total == 0:
                continue
            ratio = round(100.0 * total / rev, 2) if (rev and rev > 0) else None
            out.rpt_fy.append(Point(p=p, v=ratio, src=self.name))
