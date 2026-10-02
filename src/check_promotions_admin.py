"""Browsertest van het tabblad Promoties in admin.html (nagebootste Supabase, supabase-js lokaal geserveerd).
Gebruik: python3 src/check_promotions_admin.py <map-voor-screenshots> <pad-naar-supabase-umd.js>"""
import json, re, sys, base64, datetime, uuid
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
SHOTS, UMD = sys.argv[1], sys.argv[2]
URL = "http://localhost:8765/admin.html"
fails = []
def ok(name, cond, info=""):
    print(("  ok   " if cond else "  FOUT ") + name + (f"  [{info}]" if not cond and info != "" else ""))
    if not cond: fails.append(name)
d = datetime.date.today()
iso = lambda n: (d + datetime.timedelta(days=n)).isoformat()
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

class Store:
    def __init__(self, admin=True):
        self.admin = admin; self.promos = []; self.log = []; self.uses = {}
    def handle(self, route):
        req = route.request; u = urlparse(req.url); q = parse_qs(u.query); m = req.method; path = u.path
        def send(status=200, body=None, ct="application/json"):
            route.fulfill(status=status, content_type=ct, body="" if body is None else json.dumps(body))
        if m == "OPTIONS": return route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*"})
        if path.endswith("/rpc/is_admin"): return send(200, self.admin)
        if path.endswith("/rest/v1/bookings"):
            if "promotion_id" in q.get("select", [""])[0] and "promotion_id" in q:
                return send(200, [{"promotion_id": k} for k, n in self.uses.items() for _ in range(n)])
            return send(200, [])
        if path.endswith("/rest/v1/closures"): return send(200, [])
        if path.endswith("/rest/v1/promotions"):
            if m == "GET": return send(200, sorted(self.promos, key=lambda p: p["start_date"], reverse=True))
            body = json.loads(req.post_data or "{}")
            if m == "POST":
                self.log.append(("insert", body))
                if body.get("promo_code") and any(p.get("promo_code") == body["promo_code"] for p in self.promos):
                    return send(409, {"code": "23505", "message": 'duplicate key value violates unique constraint "promotions_code_uidx"'})
                row = dict(id=str(uuid.uuid4()), created_at="x", updated_at="x"); row.update(body); self.promos.append(row); return send(201)
            pid = q.get("id", [""])[0].replace("eq.", "")
            if m == "PATCH":
                self.log.append(("update", body)); [p.update(body) for p in self.promos if p["id"] == pid]; return send(204)
            if m == "DELETE":
                self.log.append(("delete", pid)); self.promos = [p for p in self.promos if p["id"] != pid]; return send(204)
        if "/storage/v1/object/public/" in path: return route.fulfill(status=200, content_type="image/png", body=PNG)
        if "/storage/v1/object/promotions/" in path and m == "POST": self.log.append(("upload", path.rsplit("/", 1)[-1])); return send(200, {"Key": "promotions/x", "Id": "1"})
        if "/storage/v1/object/promotions" in path and m == "DELETE": self.log.append(("storage-delete", req.post_data)); return send(200, [])
        send(404, {"message": "niet nagebootst: " + m + " " + path})

def session_js():
    exp = 4102444800
    sess = {"access_token": "aaa.bbb.ccc", "token_type": "bearer", "expires_in": 3600, "expires_at": exp, "refresh_token": "r",
            "user": {"id": "11111111-1111-1111-1111-111111111111", "aud": "authenticated", "role": "authenticated", "email": "aida@test.be"}}
    return "localStorage.setItem('sb-jdfcheqimbxffxldedey-auth-token', %s);" % json.dumps(json.dumps(sess))

def ctx_for(b, st, w=1280, h=900):
    ctx = b.new_context(viewport={"width": w, "height": h}, accept_downloads=False)
    ctx.route(re.compile(r"https://[^/]*supabase\.co/.*"), st.handle)
    ctx.route("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2", lambda r: r.fulfill(status=200, content_type="text/javascript", body=open(UMD).read()))
    ctx.add_init_script(session_js()); return ctx

def fill_form(pg, **v):
    m = {"title": "#p-title-in", "desc": "#p-desc", "value": "#p-value", "code": "#p-code", "start": "#p-start", "end": "#p-end", "delay": "#p-delay", "button": "#p-button", "priority": "#p-priority"}
    for k, sel in m.items():
        if k in v: pg.fill(sel, str(v[k]))
    if "type" in v: pg.select_option("#p-type", v["type"])
    if "service" in v: pg.select_option("#p-service", v["service"])
    for k, sel in {"active": "#p-active", "popup": "#p-popup", "banner": "#p-banner"}.items():
        if k in v: pg.set_checked(sel, v[k])

with sync_playwright() as p:
    b = p.chromium.launch()
    st = Store(); ctx = ctx_for(b, st); errs = []
    pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    pg.goto(URL); pg.wait_for_selector("#app-view:not([hidden])", timeout=5000)
    print("== Bestaande agenda blijft werken")
    ok("agenda-tab standaard zichtbaar met week + afsprakenlijst", pg.is_visible("#week") and pg.is_visible("#list") and not pg.is_visible("#view-promos"))
    ok("tabbladen Agenda | Promoties in het bestaande dashboard", pg.locator("[data-view]").count() == 2)
    print("== Promoties: lijst en validatie")
    pg.click("[data-view=promos]"); pg.wait_for_timeout(300)
    ok("tab toont lege lijst", "Nog geen promoties" in pg.inner_text("#promo-list") and not pg.is_visible("#view-agenda"))
    pg.click("#promo-new"); ok("dialoog opent met standaardwaarden", pg.is_visible("#promo-dialog") and pg.input_value("#p-start") == iso(0) and pg.is_checked("#p-popup") and not pg.is_checked("#p-banner") and pg.input_value("#p-delay") == "5")
    def try_save(expect, **v):
        fill_form(pg, **v); pg.click("#p-submit"); pg.wait_for_timeout(150)
        t = pg.inner_text("#p-msg"); ok(f"validatie: {expect[:60]}", expect.lower() in t.lower() and not any(l[0] == "insert" for l in st.log), t)
    ok_base = dict(title="Zomerkorting", value=20, end=iso(10), service="back-in-control")
    try_save("titel", title="", value=20, end=iso(10))
    try_save("korting in", title="Zomer", value="", end=iso(10))
    try_save("groter is dan 0", title="Zomer", value=-5, end=iso(10))
    try_save("maximaal 50", title="Zomer", value=80, end=iso(10))
    try_save("einddatum", title="Zomer", value=20, start=iso(5), end=iso(1))
    try_save("hoger dan de prijs", title="Zomer", value=60, type="fixed", service="back-in-control", start=iso(0), end=iso(10))
    try_save("maximaal € 100", title="Zomer", value=500, type="fixed", service="", start=iso(0), end=iso(10))
    try_save("letters, cijfers", title="Zomer", value=10, type="percentage", code="a b!", end=iso(10))
    try_save("popup-vertraging", title="Zomer", value=10, code="", delay=500, end=iso(10))
    fill_form(pg, delay=5, priority=500); pg.click("#p-submit"); pg.wait_for_timeout(100); ok("validatie: prioriteit buiten 0-100", "prioriteit" in pg.inner_text("#p-msg").lower())
    print("== Aanmaken (met afbeelding)")
    fill_form(pg, title="Zomerkorting", desc="Heerlijk", type="percentage", value=20, code="zomer20", service="back-in-control", start=iso(-1), end=iso(10), active=True, popup=True, banner=True, delay=3, button="Reserveer", priority=7)
    pg.set_input_files("#p-image", files=[{"name": "x.png", "mimeType": "image/png", "buffer": PNG}])
    ok("voorbeeld van de afbeelding", pg.is_visible("#p-img-preview"))
    pg.click("#p-submit"); pg.wait_for_timeout(600)
    ins = [l[1] for l in st.log if l[0] == "insert"]
    ok("promotie opgeslagen, dialoog gesloten", len(ins) == 1 and not pg.is_visible("#promo-dialog"), st.log)
    r = ins[0] if ins else {}
    ok("payload klopt (hoofdletters code, dienst, popup+banner, vertraging, knoptekst, prioriteit)",
       (r.get("promo_code"), r.get("service_slug"), r.get("show_popup"), r.get("show_banner"), r.get("popup_delay"), r.get("button_text"), r.get("priority"), r.get("discount_type"), r.get("discount_value")) == ("ZOMER20", "back-in-control", True, True, 3, "Reserveer", 7, "percentage", 20), r)
    ok("afbeelding geüpload naar map promotions en url bewaard", any(l[0] == "upload" for l in st.log) and "/storage/v1/object/public/promotions/" in (r.get("image_url") or ""), r.get("image_url"))
    row = pg.inner_text("#promo-list")
    ok("lijst toont titel, status, korting, dienst, data, popup/banner/code", all(t.lower() in row.lower() for t in ["Zomerkorting", "Actief nu", "20 % korting", "Back in control", "Popup", "Banner", "ZOMER20", "0 keer gebruikt"]), row)
    ok("lijst toont thumbnail", pg.locator(".prow-thumb").count() == 1)
    # tweede en derde promotie voor statussen
    for title, s, e in [("Gepland ding", iso(5), iso(9)), ("Oud ding", iso(-20), iso(-10))]:
        pg.click("#promo-new"); fill_form(pg, title=title, type="fixed", value=10, service="", start=s, end=e, popup=False, banner=False); pg.click("#p-submit"); pg.wait_for_timeout(300)
    t = pg.inner_text("#promo-list")
    tl = t.lower()
    ok("statussen Gepland en Verlopen", "gepland" in tl and "verlopen" in tl and tl.count("actief nu") == 1, t)
    ok("vaste korting met 'Alle behandelingen'", "€ 10,00 korting" in t and "Alle behandelingen" in t, t)
    pg.screenshot(path=f"{SHOTS}/admin-promoties-desktop.png", full_page=True)
    print("== Bewerken, activeren, verwijderen")
    pid = st.promos[0]["id"] if st.promos[0]["title"] == "Zomerkorting" else [x for x in st.promos if x["title"] == "Zomerkorting"][0]["id"]
    st.uses[pid] = 2
    pg.locator(".prow", has_text="Zomerkorting").get_by_role("button", name="Bewerken").click()
    ok("bewerken: formulier gevuld", pg.input_value("#p-title-in") == "Zomerkorting" and pg.input_value("#p-code") == "ZOMER20" and pg.input_value("#p-service") == "back-in-control" and pg.is_checked("#p-banner") and pg.input_value("#p-delay") == "3" and pg.is_visible("#p-img-preview") and pg.is_visible("#p-img-remove-wrap"))
    pg.fill("#p-title-in", "Zomerkorting 2"); pg.fill("#p-value", "25"); pg.set_checked("#p-img-remove", True)
    pg.click("#p-submit"); pg.wait_for_timeout(500)
    upd = [l[1] for l in st.log if l[0] == "update"][-1]
    ok("bewerken: update met nieuwe titel/korting, afbeelding verwijderd", upd.get("title") == "Zomerkorting 2" and upd.get("discount_value") == 25 and upd.get("image_url") is None, upd)
    ok("bewerken: oude afbeelding uit opslag gehaald", any(l[0] == "storage-delete" for l in st.log))
    pg.click("[data-view=agenda]"); pg.click("[data-view=promos]"); pg.wait_for_timeout(300)
    ok("lijst bijgewerkt + gebruiksteller", "Zomerkorting 2" in pg.inner_text("#promo-list") and "2 keer gebruikt" in pg.inner_text("#promo-list"), pg.inner_text("#promo-list"))
    pg.locator(".prow", has_text="Zomerkorting 2").get_by_role("button", name="Uitschakelen").click(); pg.wait_for_timeout(400)
    ok("uitschakelen: is_active=false verstuurd", [l[1] for l in st.log if l[0] == "update"][-1] == {"is_active": False})
    r2 = pg.locator(".prow", has_text="Zomerkorting 2").inner_text()
    ok("  status Uitgeschakeld en knop 'Activeren'", "uitgeschakeld" in r2.lower() and "activeren" in r2.lower(), r2)
    pg.locator(".prow", has_text="Zomerkorting 2").get_by_role("button", name="Activeren").click(); pg.wait_for_timeout(400)
    ok("activeren: is_active=true", [l[1] for l in st.log if l[0] == "update"][-1] == {"is_active": True} and "actief nu" in pg.locator(".prow", has_text="Zomerkorting 2").inner_text().lower())
    # dubbele code
    pg.click("#promo-new"); fill_form(pg, title="Kopie", type="percentage", value=10, code="zomer20", service="", start=iso(0), end=iso(3)); pg.click("#p-submit"); pg.wait_for_timeout(300)
    ok("dubbele code: duidelijke melding, dialoog blijft open", "bestaat al" in pg.inner_text("#p-msg") and pg.is_visible("#promo-dialog"), pg.inner_text("#p-msg"))
    pg.click("#promo-dialog [data-close]")
    # verwijderen: twee kliks
    n = len(st.promos)
    pg.locator(".prow", has_text="Oud ding").get_by_role("button", name="Verwijderen").click(); pg.wait_for_timeout(100)
    ok("verwijderen vraagt bevestiging (nog niets verwijderd)", len(st.promos) == n and "zeker" in pg.locator(".prow", has_text="Oud ding").inner_text().lower())
    pg.locator(".prow", has_text="Oud ding").get_by_role("button", name=re.compile("Zeker")).click(); pg.wait_for_timeout(400)
    ok("tweede klik verwijdert", len(st.promos) == n - 1 and "Oud ding" not in pg.inner_text("#promo-list"))
    ok("geen console-fouten (behalve de verwachte 409 bij dubbele code)", all("409" in e for e in errs), errs)
    ctx.close()

    print("== Mobiel")
    st = Store(); ctx = ctx_for(b, st, 390, 844); errs = []
    st.promos = [dict(id="p1", title="Winteractie met een best lange titel om te zien hoe het afbreekt", description=None, image_url=None, discount_type="percentage", discount_value=20, promo_code="WINTER20", service_slug="back-in-control",
                      start_date=iso(-1), end_date=iso(20), is_active=True, show_popup=True, show_banner=True, popup_delay=5, button_text="Boek nu", priority=0)]
    pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e))); pg.goto(URL); pg.wait_for_selector("#app-view:not([hidden])"); pg.click("[data-view=promos]"); pg.wait_for_timeout(300)
    ok("mobiel: geen horizontale scroll", pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), pg.evaluate("document.documentElement.scrollWidth"))
    pg.screenshot(path=f"{SHOTS}/admin-promoties-mobiel.png", full_page=True)
    pg.click("#promo-new"); pg.wait_for_timeout(200)
    ok("mobiel: dialoog past in scherm en scrolt", pg.evaluate("(() => { const r = document.getElementById('promo-dialog').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight + 1; })()"))
    pg.screenshot(path=f"{SHOTS}/admin-dialoog-mobiel.png")
    ok("geen JS-fouten", not errs, errs); ctx.close()

    print("== Geen beheerder")
    st = Store(admin=False); ctx = ctx_for(b, st); pg = ctx.new_page(); pg.goto(URL); pg.wait_for_selector("#info-view:not([hidden])", timeout=5000)
    ok("ingelogd zonder beheerrechten: 'Geen toegang', geen tabbladen", "Geen toegang" in pg.inner_text("#info-view") and not pg.is_visible("#app-view"))
    ctx.close(); b.close()
print("\n" + ("ALLES GESLAAGD" if not fails else f"{len(fails)} FOUT(EN): " + "; ".join(fails)))
sys.exit(1 if fails else 0)
