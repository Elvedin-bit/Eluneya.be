"""Doorloopt de agenda met een nagebootste Supabase: dag, uur, validatie, boeken, bevestiging, fout bij bezet tijdslot."""
import json, re, datetime, sys
from playwright.sync_api import sync_playwright
mode = {"book": "ok"}
calls = []
def mock(route):
    url = route.request.url; body = json.loads(route.request.post_data or "{}"); calls.append((url.rsplit('/',1)[-1], body, route.request.headers.get('apikey')))
    if url.endswith("get_booked_slots"):
        start = datetime.date.fromisoformat(body["p_from"]); rows = []
        for i in range(7):
            d = start + datetime.timedelta(days=i)
            if d.weekday() == 2: rows.append({"booking_date": d.isoformat(), "start_time": "13:00:00", "blocked_until": "14:15:00"})
        return route.fulfill(status=200, content_type="application/json", body=json.dumps(rows))
    if mode["book"] == "bezet":
        return route.fulfill(status=400, content_type="application/json", body=json.dumps({"code": "P0001", "message": "tijdslot_bezet"}))
    return route.fulfill(status=200, content_type="application/json", body=json.dumps({"id": "abc", "service": "Back in control", "date": body["p_date"], "start": body["p_start"], "end": "x"}))
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={"width": 390, "height": 844}, reduced_motion="reduce")
    ctx.route(re.compile(r"https://.*\.supabase\.co/.*"), mock)
    errs = []
    pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    pg.goto("http://localhost:8765/afspraak.html?behandeling=back-in-control"); pg.wait_for_timeout(500)
    print("voorselectie:", pg.input_value("#service"), "|", pg.text_content("#service-summary"))
    print("week:", pg.text_content("#week-label"), "| prev disabled:", pg.is_disabled("#prev-week"))
    days = pg.eval_on_selector_all(".day-btn", "els => els.map(e => e.getAttribute('aria-label') + (e.disabled ? ' [x]' : ''))"); print("dagen:", days)
    # volgende week, woensdag kiezen
    pg.click("#next-week"); pg.wait_for_timeout(300)
    wed = pg.query_selector_all(".day-btn")[2]; print("woensdag:", wed.get_attribute("aria-label")); wed.click(); pg.wait_for_timeout(200)
    slots = pg.eval_on_selector_all(".slot-btn", "els => els.map(e => e.textContent + (e.disabled ? 'x' : ''))"); print("uren woe (45 min + 15 buffer, 13:00-14:15 bezet):", slots)
    # verzenden zonder gegevens
    pg.click("#submit-btn"); print("melding zonder uur:", pg.text_content("#form-message"))
    pg.click(".slot-btn:not(:disabled) >> nth=0"); print("samenvatting:", pg.text_content("#booking-summary"))
    pg.click("#submit-btn"); print("melding zonder gegevens:", pg.text_content("#form-message"), "| focus:", pg.evaluate("document.activeElement.id"), "| invalid:", pg.get_attribute("#name","aria-invalid"))
    pg.fill("#name", "Test Klant"); pg.fill("#email", "test@voorbeeld.be")
    mode["book"] = "bezet"; pg.click("#submit-btn"); pg.wait_for_timeout(400); print("bij bezet:", pg.text_content("#form-message"))
    pg.click(".slot-btn:not(:disabled) >> nth=1"); mode["book"] = "ok"; pg.click("#submit-btn"); pg.wait_for_timeout(400)
    print("bevestiging zichtbaar:", pg.is_visible("#booking-done"), "|", pg.text_content("#done-details"), "| ics:", pg.get_attribute("#ics-link","href")[:5])
    print("laatste boeking payload:", [c for c in calls if c[0]=="book_appointment"][-1][1], "| apikey header:", bool(calls[-1][2]))
    pg.screenshot(path=sys.argv[1] + "/booking-done.png")
    # niet-geconfigureerde agenda
    pg2 = ctx.new_page(); pg2.route("**/assets/js/config.js", lambda r: r.fulfill(status=200, content_type="text/javascript", body="window.ELUNEYA_CONFIG={supabaseUrl:'',supabaseKey:''};"))
    pg2.goto("http://localhost:8765/afspraak.html"); pg2.wait_for_timeout(300)
    print("zonder config -> fallback zichtbaar:", pg2.is_visible("#booking-unavailable"), "| formulier verborgen:", not pg2.is_visible("#booking-form"))
    # mobiel menu: openen, Escape, focus
    pg3 = ctx.new_page(); pg3.goto("http://localhost:8765/index.html")
    pg3.click(".nav-toggle"); pg3.wait_for_timeout(200)
    print("menu open:", pg3.get_attribute(".nav-toggle","aria-expanded"), pg3.get_attribute(".nav-toggle","aria-label"), "| focus op:", pg3.evaluate("document.activeElement.textContent"), "| main inert:", pg3.evaluate("document.querySelector('main').inert"))
    pg3.screenshot(path=sys.argv[1] + "/mobile-menu.png")
    pg3.keyboard.press("Escape"); pg3.wait_for_timeout(200)
    print("na Escape:", pg3.get_attribute(".nav-toggle","aria-expanded"), "| focus terug op toggle:", pg3.evaluate("document.activeElement.classList.contains('nav-toggle')"))
    # zonder JavaScript: is alle inhoud zichtbaar?
    ctx2 = b.new_context(java_script_enabled=False); pg4 = ctx2.new_page(); pg4.goto("http://localhost:8765/index.html")
    print("zonder JS, opacity eerste .reveal:", pg4.evaluate("getComputedStyle(document.querySelector('.reveal')).opacity") if False else pg4.eval_on_selector(".reveal", "e => getComputedStyle(e).opacity"))
    print("fouten:", errs)
    b.close()
