"""
Free-tier screener.in scraper. Pulls promoter holding (quarterly + annual)
from the public company page. Pledge and RPT are NOT available on the
public tier (screener moved them behind Pro) — those return empty here.
"""
from __future__ import annotations
import httpx
from bs4 import BeautifulSoup
from .base import Provider, ShareholdingData, Point


class ScreenerPublic(Provider):
    name = "screener_public"
    needs_auth = False
    BASE = "https://www.screener.in"

    def _get(self, url):
        r = self.client.get(
            url, headers={"User-Agent": self.UA, "Accept-Language": "en-US,en"},
            timeout=30, follow_redirects=True,
        )
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.text

    def fetch(self, row) -> ShareholdingData:
        slug = row["screener_slug"]
        html = None
        for path in (f"/company/{slug}/consolidated/", f"/company/{slug}/"):
            try:
                html = self._get(self.BASE + path)
                if html:
                    break
            except httpx.HTTPError:
                html = None
        if not html:
            return ShareholdingData(source=self.name, err="page not reachable")
        return self._parse(html)

    def _parse(self, html) -> ShareholdingData:
        out = ShareholdingData(source=self.name)
        soup = BeautifulSoup(html, "lxml")
        sec = soup.find("section", id="shareholding")
        if not sec:
            out.err = "no shareholding section"
            return out

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
            ths = thead.find_all("th")
            periods = [th.get_text(strip=True) for th in ths[1:]]

            tbody = table.find("tbody")
            if not tbody:
                continue
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
        return out
