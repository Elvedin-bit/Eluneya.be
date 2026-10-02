"""Eindcontrole: console, netwerk, links, axe-toegankelijkheid en screenshots."""
import json, re, sys, pathlib, datetime
from urllib.parse import urljoin, urlparse
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8765/"
PAGES = ["index.html", "behandelingen.html", "journeys.html", "over.html", "contact.html",
         "afspraak.html", "privacy.html", "voorwaarden.html", "404.html"]
OUT = pathlib.Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
AXE = pathlib.Path(sys.argv[2]).read_text()

def mock_supabase(route):
    url = route.request.url
    if url.endswith("/rpc/get_booked_slots"):
        body = json.loads(route.request.post_data or "{}")
        start = datetime.date.fromisoformat(body["p_from"])
        rows = []
        for i in range(7):
            d = start + datetime.timedelta(days=i)
            if d.weekday() == 0:   # maandag: 18:30-19:45 bezet
                rows.append({"booking_date": d.isoformat(), "start_time": "18:30:00", "blocked_until": "19:45:00"})
        return route.fulfill(status=200, content_type="application/json", body=json.dumps(rows))
    if url.endswith("/rpc/book_appointment"):
        body = json.loads(route.request.post_data or "{}")
        return route.fulfill(status=200, content_type="application/json", body=json.dumps(
            {"id": "test-id", "service": "Mind control", "date": body["p_date"], "start": body["p_start"], "end": "x"}))
    if "/rest/v1/promotions" in url:   # één lopende promotie met banner + popup, zodat ook die op toegankelijkheid gecontroleerd worden
        return route.fulfill(status=200, content_type="application/json", body=json.dumps([{
            "id": "aaaaaaaa-0000-0000-0000-000000000001", "title": "Winteractie", "description": "Een heerlijke korting op je rugmassage.",
            "image_url": None, "discount_type": "percentage", "discount_value": 20, "service_slug": "back-in-control", "end_date": "2026-12-31",
            "show_popup": True, "show_banner": True, "popup_delay": 0, "button_text": "Boek nu", "priority": 1, "requires_code": False}]))
    if url.endswith("/rpc/get_price_quote"):
        return route.fulfill(status=200, content_type="application/json", body=json.dumps({"list_price": 50, "discount": 10, "price": 40, "promotion": "Winteractie", "code_status": "none"}))
    return route.fulfill(status=404, body="{}")

report = {"console": [], "failed": [], "axe": {}, "links": []}
seen_links = set()
with sync_playwright() as p:
    b = p.chromium.launch()
    for vp_name, vp in [("desktop", {"width": 1440, "height": 900}), ("mobile", {"width": 390, "height": 844})]:
        ctx = b.new_context(viewport=vp, reduced_motion="reduce", device_scale_factor=1, is_mobile=(vp_name == "mobile"), has_touch=(vp_name == "mobile"))
        ctx.route(re.compile(r"https://.*\.supabase\.co/.*"), mock_supabase)
        for page_name in PAGES:
            pg = ctx.new_page()
            pg.on("console", lambda m, n=page_name: m.type in ("error", "warning") and report["console"].append(f"{vp_name} {n}: {m.type}: {m.text}"))
            pg.on("pageerror", lambda e, n=page_name: report["console"].append(f"{vp_name} {n}: PAGEERROR {e}"))
            pg.on("response", lambda r, n=page_name: r.status >= 400 and "404.html" not in n and report["failed"].append(f"{n}: {r.status} {r.url}"))
            pg.goto(BASE + page_name, wait_until="networkidle")
            pg.wait_for_timeout(300)
            # horizontale scroll?
            ow = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
            if ow > 0: report["console"].append(f"{vp_name} {page_name}: HORIZONTAAL SCROLLEN {ow}px")
            if vp_name == "desktop":
                pg.add_script_tag(content=AXE)
                res = pg.evaluate("""async () => (await axe.run(document, {runOnly: ['wcag2a','wcag2aa','wcag21aa','best-practice']})).violations
                    .map(v => ({id: v.id, impact: v.impact, n: v.nodes.length, help: v.help, t: v.nodes.slice(0,3).map(x => x.target.join(' '))}))""")
                if res: report["axe"][page_name] = res
                for href in pg.eval_on_selector_all("a[href]", "els => els.map(e => e.getAttribute('href'))"):
                    full = urljoin(BASE + page_name, href)
                    u = urlparse(full)
                    if u.netloc == "localhost:8765":
                        seen_links.add(full.split("#")[0].split("?")[0])
                        if "#" in href and not href.startswith("#") is False:
                            pass
                    report["links"].append(href) if False else None
            pg.evaluate("""async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); } window.scrollTo(0, 0); }""")
            pg.wait_for_timeout(400)
            pg.screenshot(path=str(OUT / f"{vp_name}-{page_name.replace('.html','')}.png"), full_page=True)
            pg.close()
        ctx.close()
    # interne links controleren
    ctx = b.new_context()
    pg = ctx.new_page()
    for link in sorted(seen_links):
        r = pg.goto(link)
        if not r or r.status != 200:
            report["failed"].append(f"LINK {link} -> {r.status if r else 'geen antwoord'}")
    # ankers controleren
    for page_name in PAGES:
        pg.goto(BASE + page_name)
        for href in pg.eval_on_selector_all("a[href*='#']", "els => els.map(e => e.getAttribute('href'))"):
            path, _, frag = href.partition("#")
            if not frag: continue
            target = urljoin(BASE + page_name, path) if path else BASE + page_name
            pg2 = ctx.new_page(); pg2.goto(target)
            if not pg2.query_selector(f"#{frag}"):
                report["failed"].append(f"ANKER {page_name}: {href} bestaat niet")
            pg2.close()
    b.close()

print(json.dumps({k: v for k, v in report.items() if k != "links"}, indent=1, ensure_ascii=False))
print("interne links gecontroleerd:", len(seen_links))
