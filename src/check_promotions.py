"""Browsertest van popup, banner en promotieprijs in de afspraak (met nagebootste Supabase).
Gebruik: python3 src/check_promotions.py <map-voor-screenshots>   (site moet draaien op http://localhost:8765)"""
import json, re, sys, datetime
from playwright.sync_api import sync_playwright
SHOTS = sys.argv[1]
URL = "http://localhost:8765/"
fails = []
def ok(name, cond, info=""):
    print(("  ok   " if cond else "  FOUT ") + name + (f"  [{info}]" if not cond and info != "" else ""))
    if not cond: fails.append(name)

PRICES = {"back-in-control": 50, "mind-control": 40, "higher-self": 75, "intakegesprek": 0}
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#cbb8a3"/><circle cx="400" cy="225" r="90" fill="#efe8de"/></svg>'

def promo(**kw):
    p = dict(id="aaaaaaaa-0000-0000-0000-000000000001", title="Winteractie", description="Een heerlijke korting op je rugmassage.",
             image_url=None, discount_type="percentage", discount_value=20, service_slug="back-in-control", end_date="2026-12-31",
             show_popup=True, show_banner=True, popup_delay=1, button_text="Boek nu", priority=10, requires_code=False)
    p.update(kw); return p

class Backend:
    def __init__(self, promos=None, quote=True, promo_status=200):
        self.promos = promos or []; self.quote_ok = quote; self.promo_status = promo_status
        self.calls = []; self.book_mode = "ok"; self.codes = {"WELKOM10": 10}; self.used_email = None
    def price(self, slug, code):
        lst = PRICES[slug]; best = 0; title = None; status = "none"
        if code:
            status = "ok" if (code in self.codes and lst > 0) else "invalid"
        for p in self.promos:
            if p["service_slug"] in (None, slug) and not p["requires_code"] and lst > 0:
                d = round(lst * p["discount_value"] / 100, 2) if p["discount_type"] == "percentage" else min(p["discount_value"], lst)
                if d > best: best, title = d, p["title"]
        if status == "ok" and lst * self.codes[code] / 100 > best:
            best, title = round(lst * self.codes[code] / 100, 2), "Welkomstcode"
        return dict(list_price=lst, discount=best, price=lst - best, promotion=title, code_status=status)
    def handle(self, route):
        req = route.request; url = req.url
        def send(status, body): route.fulfill(status=status, content_type="application/json", body=json.dumps(body))
        if "/rest/v1/promotions" in url:
            self.calls.append(("GET promotions", url))
            return send(self.promo_status, self.promos if self.promo_status == 200 else {"message": "boom"})
        body = json.loads(req.post_data or "{}")
        name = url.rsplit("/", 1)[-1]; self.calls.append((name, body))
        if name == "get_booked_slots": return send(200, [])
        if name == "get_price_quote":
            if not self.quote_ok: return send(404, {"code": "PGRST202", "message": "not found"})
            return send(200, self.price(body["p_service"], body.get("p_code")))
        if name == "book_appointment":
            if self.book_mode == "prijs":
                return send(400, {"code": "P0001", "message": "prijs_gewijzigd:50.00"})
            if self.book_mode == "code_used":
                return send(400, {"code": "P0001", "message": "code_al_gebruikt"})
            q = self.price(body["p_service"], body.get("p_promo_code"))
            return send(200, {"id": "x", "service": "Back in control", "date": body["p_date"], "start": body["p_start"], "end": "x",
                              "list_price": q["list_price"], "discount": q["discount"], "price": q["price"], "promotion": q["promotion"]})
        send(404, {})

def new_ctx(b, be, w=1280, h=800, **kw):
    ctx = b.new_context(viewport={"width": w, "height": h}, **kw)
    ctx.route(re.compile(r"https://[^/]*supabase\.co/.*"), be.handle)
    ctx.route("https://img.test/**", lambda r: r.fulfill(status=200, content_type="image/svg+xml", body=SVG))
    return ctx

def page(ctx, path, errs):
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
    pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    pg.goto(URL + path); return pg

def header_top(pg): return pg.evaluate("Math.round(document.querySelector('.site-header').getBoundingClientRect().top)")
def popup_open(pg): return pg.evaluate("!!document.querySelector('dialog.promo-popup[open]')")

with sync_playwright() as p:
    b = p.chromium.launch()

    for label, (w, h) in {"desktop": (1280, 800), "mobiel": (390, 844)}.items():
        print(f"\n== Popup en banner ({label} {w}px)")
        be = Backend([promo(image_url="https://img.test/p.svg"), promo(id="aaaaaaaa-0000-0000-0000-000000000002", title="Lager", priority=1, show_popup=False)])
        ctx = new_ctx(b, be, w, h); errs = []
        pg = page(ctx, "index.html", errs); pg.wait_for_selector(".promo-banner", timeout=4000)
        ok("banner verschijnt", True)
        txt = pg.inner_text(".promo-banner")
        ok("banner toont titel + korting + knop", "Winteractie" in txt and "20% korting op Back in control" in txt and "boek nu" in txt.lower(), txt)
        ok("hoogste prioriteit eerst (maar 1 banner)", pg.locator(".promo-banner").count() == 1 and "Lager" not in txt)
        ok("banner-knop leidt naar de juiste dienst", pg.get_attribute(".promo-banner-btn", "href").endswith("/afspraak.html?behandeling=back-in-control"), pg.get_attribute(".promo-banner-btn", "href"))
        bh = pg.evaluate("Math.round(document.querySelector('.promo-banner').getBoundingClientRect().height)")
        ok("header staat onder de banner", header_top(pg) == bh, f"{header_top(pg)} vs {bh}")
        ok("geen horizontale scroll", pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
        pg.screenshot(path=f"{SHOTS}/banner-{label}.png")
        pg.evaluate("window.scrollTo(0, 400)"); pg.wait_for_timeout(150)
        ok("header schuift naar boven bij scrollen", header_top(pg) == 0, header_top(pg))
        pg.evaluate("window.scrollTo(0, 0)")
        ok("popup nog niet zichtbaar vóór de vertraging", not popup_open(pg))
        pg.wait_for_selector("dialog.promo-popup[open]", timeout=4000)
        ok("popup verschijnt na de vertraging", True)
        pop = pg.inner_text("dialog.promo-popup")
        ok("popup toont titel, korting, beschrijving, knop", all(t.lower() in pop.lower() for t in ["Winteractie", "20% korting op Back in control", "heerlijke korting", "Boek nu", "Tot en met 31 december"]), pop)
        ok("popup-knop leidt naar de dienst", pg.get_attribute(".promo-popup .btn", "href").endswith("/afspraak.html?behandeling=back-in-control"))
        ok("afbeelding geladen", pg.evaluate("(() => { const i = document.querySelector('.promo-popup-media'); return !!i && i.complete && i.naturalWidth > 0; })()"))
        box = pg.evaluate("(() => { const r = document.querySelector('.promo-popup-card').getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom]; })()")
        ok("popup past in het scherm", box[0] >= 0 and box[1] <= w and box[2] >= 0 and box[3] <= h, box)
        pg.wait_for_timeout(600);         cw = pg.evaluate("document.querySelector('.promo-popup-close').getBoundingClientRect().width")
        ok("sluitknop heeft label en is 44px", pg.get_attribute(".promo-popup-close", "aria-label") == "Sluiten" and cw >= 44, f"label={pg.get_attribute('.promo-popup-close', 'aria-label')} w={cw}")
        pg.wait_for_timeout(500); pg.screenshot(path=f"{SHOTS}/popup-{label}.png")
        pg.click(".promo-popup-close"); pg.wait_for_timeout(150)
        ok("X sluit de popup", not popup_open(pg) and pg.locator("dialog.promo-popup").count() == 0)
        # banner sluiten
        pg.click(".promo-banner-close"); pg.wait_for_timeout(100)
        ok("banner sluiten werkt, header terug bovenaan", pg.locator(".promo-banner").count() == 0 and header_top(pg) == 0)
        pg.reload(); pg.wait_for_timeout(2500)
        ok("na herladen: popup niet opnieuw (opslag)", not popup_open(pg))
        ok("na herladen: gesloten banner blijft weg (deze sessie)", pg.locator(".promo-banner").count() == 0)
        # nieuw tabblad: banner terug, popup nog niet (7 dagen)
        pg2 = page(ctx, "over.html", errs); pg2.wait_for_timeout(2500)
        ok("nieuw bezoek: banner terug", pg2.locator(".promo-banner").count() == 1)
        ok("nieuw bezoek op andere pagina: popup nog steeds niet (zelfde promotie)", not popup_open(pg2))
        # 8 dagen geleden gezien -> opnieuw
        old = int((datetime.datetime.now().timestamp() - 8 * 86400) * 1000)
        pg2.evaluate(f"localStorage.setItem('eluneya:popup:aaaaaaaa-0000-0000-0000-000000000001', '{old}')")
        pg3 = page(ctx, "contact.html", errs); pg3.wait_for_selector("dialog.promo-popup[open]", timeout=4000)
        ok("na 8 dagen verschijnt de popup opnieuw", True)
        pg3.keyboard.press("Escape"); pg3.wait_for_timeout(150)
        ok("Escape sluit de popup", not popup_open(pg3))
        pg3.evaluate(f"localStorage.setItem('eluneya:popup:aaaaaaaa-0000-0000-0000-000000000001', '{old}')")
        pg4 = page(ctx, "over.html", errs); pg4.wait_for_selector("dialog.promo-popup[open]", timeout=4000)
        pg4.mouse.click(5, 5); pg4.wait_for_timeout(150)
        ok("klik naast de popup sluit hem", not popup_open(pg4))
        ok("popup niet twee keer in dezelfde sessie", True)
        ok(f"geen console-fouten ({label})", not errs, errs)
        ctx.close()

    print("\n== Popup niet op de afsprakenpagina, wel banner; geen promoties = niets")
    be = Backend([promo()]); ctx = new_ctx(b, be); errs = []
    pg = page(ctx, "afspraak.html", errs); pg.wait_for_timeout(2500)
    ok("afspraakpagina: banner wel", pg.locator(".promo-banner").count() == 1)
    ok("afspraakpagina: popup niet", not popup_open(pg))
    ctx.close()
    for lbl, be in {"geen promoties": Backend([]), "server geeft 500": Backend([promo()], promo_status=500)}.items():
        ctx = new_ctx(b, be); errs = []; pg = page(ctx, "index.html", errs); pg.wait_for_timeout(2500)
        ok(f"{lbl}: geen banner/popup, site werkt", pg.locator(".promo-banner").count() == 0 and not popup_open(pg) and pg.locator("h1").count() == 1)
        ctx.close()
    be = Backend([promo(requires_code=True, show_banner=False, popup_delay=0, service_slug=None, discount_type="fixed", discount_value=10)])
    ctx = new_ctx(b, be); errs = []; pg = page(ctx, "index.html", errs); pg.wait_for_selector("dialog.promo-popup[open]", timeout=3000)
    t = pg.inner_text("dialog.promo-popup")
    ok("code-promo: toont code-hint, nooit de code; vast bedrag; alle behandelingen", "promotiecode" in t and "€ 10 korting op elke behandeling" in t, t)
    ok("zonder dienst: link naar afspraakpagina zonder voorselectie", pg.get_attribute(".promo-popup .btn", "href").endswith("/afspraak.html"))
    ok("aanvraag vraagt promo_code niet op", all("promo_code" not in c[1] for c in be.calls if c[0] == "GET promotions"))
    ctx.close()
    ctx = new_ctx(b, Backend([promo(title="<img src=x onerror=alert(1)>", description="<b>vet</b>", show_banner=True, popup_delay=0)]))
    errs = []; pg = page(ctx, "index.html", errs); pg.wait_for_selector("dialog.promo-popup[open]", timeout=3000)
    ok("HTML in titel/beschrijving wordt als tekst getoond (geen XSS)", pg.locator("dialog.promo-popup img[src='x']").count() == 0 and "<b>vet</b>" in pg.inner_text("dialog.promo-popup"))
    ctx.close()

    print("\n== Afspraak: kortingsprijs en promotiecode")
    def start_booking(be, w=390, h=844, path="afspraak.html?behandeling=back-in-control"):
        ctx = new_ctx(b, be, w, h); errs = []; pg = page(ctx, path, errs); pg.wait_for_timeout(600); return ctx, pg, errs
    be = Backend([promo(show_popup=False, show_banner=False)])
    ctx, pg, errs = start_booking(be)
    s = pg.inner_text("#service-summary")
    ok("automatische korting: € 40,00 (normaal € 50,00) + actienaam", "€ 40,00" in s and "normaal € 50,00" in s and "Winteractie" in s, s)
    ok("orginele prijs blijft zichtbaar als 'normaal'", True)
    pg.select_option("#service", "higher-self"); pg.wait_for_timeout(300)
    s = pg.inner_text("#service-summary"); ok("andere dienst zonder promotie: gewone prijs", "€ 75,00" in s and "normaal" not in s, s)
    pg.select_option("#service", "back-in-control"); pg.wait_for_timeout(300)
    ok("promocodeknop zichtbaar", pg.is_visible("#promo-toggle"))
    pg.click("#promo-toggle"); ok("veld opent", pg.is_visible("#promo-code"))
    pg.fill("#promo-code", "fout"); pg.click("#promo-apply"); pg.wait_for_timeout(300)
    ok("ongeldige code: melding", "ongeldig" in pg.inner_text("#promo-status"), pg.inner_text("#promo-status"))
    pg.fill("#promo-code", "welkom10"); pg.click("#promo-apply"); pg.wait_for_timeout(300)
    ok("geldige code: bevestigd", "Code toegepast" in pg.inner_text("#promo-status"), pg.inner_text("#promo-status"))
    s = pg.inner_text("#service-summary"); ok("grootste korting wint, niet gecombineerd (20 % blijft 40)", "€ 40,00" in s, s)
    pg.select_option("#service", "higher-self"); pg.wait_for_timeout(300)
    s = pg.inner_text("#service-summary"); ok("code op andere dienst: € 67,50", "€ 67,50" in s and "normaal € 75,00" in s, s)
    # boeken
    pg.click(".day-btn:not(:disabled) >> nth=0"); pg.click(".slot-btn:not(:disabled) >> nth=0")
    ok("samenvatting toont kortingsprijs", "€ 67,50" in pg.inner_text("#booking-summary") and "normaal € 75,00" in pg.inner_text("#booking-summary"), pg.inner_text("#booking-summary"))
    pg.fill("#name", "Test Klant"); pg.fill("#email", "t@test.be")
    pg.fill("#promo-code", "ANDERS"); pg.click("#submit-btn"); pg.wait_for_timeout(200)
    ok("niet-toegepaste code blokkeert verzenden", "Toepassen" in pg.inner_text("#form-message") and not any(c[0] == "book_appointment" for c in be.calls))
    pg.fill("#promo-code", "WELKOM10"); pg.click(".day-btn:not(:disabled) >> nth=0")
    pg.click(".slot-btn:not(:disabled) >> nth=0")
    pg.screenshot(path=f"{SHOTS}/boeking-promo.png", full_page=False)
    pg.click("#submit-btn"); pg.wait_for_timeout(500)
    bk = [c for c in be.calls if c[0] == "book_appointment"][-1][1]
    ok("payload: code + verwachte prijs mee", bk.get("p_promo_code") == "WELKOM10" and bk.get("p_expected_price") == 67.5, bk)
    ok("bevestiging toont korting", "Prijs na korting: € 67,50 (normaal € 75,00)" in pg.inner_text("#done-details"), pg.inner_text("#done-details"))
    ok("geen console-fouten", not errs, errs)
    ctx.close()
    # prijs wijzigt tijdens boeken
    be = Backend([promo(show_popup=False, show_banner=False)]); ctx, pg, errs = start_booking(be)
    pg.click(".day-btn:not(:disabled) >> nth=0"); pg.click(".slot-btn:not(:disabled) >> nth=0"); pg.fill("#name", "Test Klant"); pg.fill("#email", "t@test.be")
    be.book_mode = "prijs"; pg.click("#submit-btn"); pg.wait_for_timeout(500)
    ok("prijs_gewijzigd: melding met nieuw bedrag, niet geboekt", "€ 50,00" in pg.inner_text("#form-message") and not pg.is_visible("#booking-done"), pg.inner_text("#form-message"))
    ok("  en de getoonde prijs is het bevestigde bedrag", "€ 50,00" in pg.inner_text("#service-summary"), pg.inner_text("#service-summary"))
    be.book_mode = "ok"; pg.click("#submit-btn"); pg.wait_for_timeout(400)
    bk = [c for c in be.calls if c[0] == "book_appointment"][-1][1]
    ok("  volgende poging stuurt de bevestigde prijs", bk.get("p_expected_price") == 50, bk)
    ctx.close()
    # code via URL
    be = Backend([]); ctx, pg, errs = start_booking(be, path="afspraak.html?behandeling=higher-self&code=welkom10")
    ok("?code= vult in en past toe", pg.input_value("#promo-code") == "WELKOM10" and "€ 67,50" in pg.inner_text("#service-summary"), pg.inner_text("#service-summary"))
    ctx.close()
    # oude database zonder promotiefuncties
    be = Backend([], quote=False); ctx, pg, errs = start_booking(be)
    ok("zonder promotiefuncties: gewone prijs, geen codeknop", "€ 50,00" in pg.inner_text("#service-summary") and not pg.is_visible("#promo-toggle"))
    pg.click(".day-btn:not(:disabled) >> nth=0"); pg.click(".slot-btn:not(:disabled) >> nth=0"); pg.fill("#name", "Test Klant"); pg.fill("#email", "t@test.be"); pg.click("#submit-btn"); pg.wait_for_timeout(400)
    bk = [c for c in be.calls if c[0] == "book_appointment"][-1][1]
    ok("  boeken stuurt de oorspronkelijke 7 parameters", "p_promo_code" not in bk and "p_expected_price" not in bk and pg.is_visible("#booking-done"), bk)
    ctx.close()
    b.close()

print("\n" + ("ALLES GESLAAGD" if not fails else f"{len(fails)} FOUT(EN): " + "; ".join(fails)))
sys.exit(1 if fails else 0)
