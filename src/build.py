#!/usr/bin/env python3
"""Bouwscript voor de Eluneya-website.

Eén bron van waarheid voor gegevens die op meerdere plaatsen terugkomen
(contactgegevens, openingsuren, behandelingen en prijzen). Het script
voegt header, footer en <head> toe aan de pagina's in src/pages/ en
genereert ook assets/js/services.js en supabase/schema.sql, zodat de
website, de boekingsagenda en de database altijd dezelfde behandelingen,
duur en openingsuren gebruiken.

Gebruik:  python3 src/build.py      (vanuit de projectmap)
Uitvoer:  site/
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "pages"
OUT = ROOT / "site"

# ---------------------------------------------------------------------------
# 1. Bedrijfsgegevens
#    Alles met "IN TE VULLEN" ontbreekt nog; alles met "CONTROLEREN" komt van
#    de huidige site of de oude index en moet Aida bevestigen.
# ---------------------------------------------------------------------------
SITE = {
    # CONTROLEREN: definitief domein (ook gebruikt in canonical, og:image, sitemap, robots.txt)
    "domain": "https://www.eluneya.be",
    "name": "Eluneya",
    "owner": "Aida",
    "legal_name": "[IN TE VULLEN: juridische naam, bv. voor- en achternaam bij een eenmanszaak]",
    "street": "Jan Breydelstraat 1",
    "postal": "8560",
    "city": "Wevelgem",
    "country": "BE",
    "phone_display": "0483 00 53 04",
    "phone_e164": "+32483005304",
    # CONTROLEREN: aangenomen dat WhatsApp op hetzelfde nummer werkt
    "whatsapp": "32483005304",
    "email": "[IN TE VULLEN: e-mailadres]",
    "vat_display": "BE 1033.875.191",
    "vat_id": "BE1033875191",
    "kbo": "1033.875.191",
    "instagram": "https://www.instagram.com/eluneya_/",
    "instagram_handle": "@eluneya_",
}

# CONTROLEREN: openingsuren komen uit de oude index (dow: 0 = zondag … 6 = zaterdag, zoals JavaScript)
HOURS = {1: ("18:30", "20:30"), 3: ("13:00", "21:00"), 5: ("18:30", "20:30"), 6: ("15:30", "20:30")}
DAY_NAMES = ["Zondag", "Maandag", "Dinsdag", "Woensdag", "Donderdag", "Vrijdag", "Zaterdag"]
SCHEMA_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

# Boekingsregels — moeten gelijk zijn in de site en de database (worden hieronder in beide gezet)
BOOKING = {"slot_step": 30, "buffer_minutes": 15, "min_notice_hours": 3, "max_days_ahead": 56, "max_open_per_email": 3}

# ---------------------------------------------------------------------------
# 2. Behandelingen
#    duration: minuten (gebruikt door de agenda). show_duration=False: de duur
#    is nog niet bevestigd en wordt dus niet getoond, maar de agenda blokkeert
#    wel deze tijd. → CONTROLEREN bij Aida.
# ---------------------------------------------------------------------------
CATEGORIES = [
    {
        "id": "intake", "title": "Intakegesprek",
        "intro": "Twijfel je welke behandeling of journey bij je past? Start met een vrijblijvende kennismaking.",
        "items": [
            {"slug": "intakegesprek", "name": "Intakegesprek", "duration": 30, "price": 0, "show_duration": True,
             "desc": "Een gesprek van 30 minuten om kennis te maken en je vragen te verkennen. Kan ter plaatse of online."},
        ],
    },
    {
        "id": "season-specials", "title": "Season specials",
        "intro": "Seizoensrituelen waarin lichaam, energie en rust samenkomen. Elk ritueel start op de trilplaat.",
        "items": [
            {"slug": "melt-away", "name": "Melt Away", "duration": 60, "price": 55, "show_duration": False,
             "includes": ["Trilplaat", "Rugmassage", "Cupping", "Hotstone", "Energetische reset met wierook"]},
            {"slug": "higher-self", "name": "Higher Self", "duration": 75, "price": 75, "show_duration": False,
             "includes": ["Trilplaat", "Gelaatsverzorging", "Hoofdmassage", "Hartchakra-healing", "Aromatherapie"]},
            {"slug": "go-within", "name": "Go Within", "duration": 90, "price": 95, "show_duration": False,
             "includes": ["Trilplaat", "Hoofd-, nek- en schoudermassage", "Voetreflexologie", "Rootchakra-healing", "Meditatie & reflectie"]},
        ],
    },
    {
        "id": "gentleman-reset", "title": "Gentleman Reset",
        "intro": "Massages voor wie spanning meedraagt in rug, nek of hoofd en even helemaal wil resetten.",
        "items": [
            {"slug": "iron-back-mind-reset", "name": "Iron back & mind reset", "duration": 60, "price": 65, "show_duration": True,
             "desc": "Een deeptissue rugmassage, inclusief gelaat en hoofd."},
            {"slug": "back-in-control", "name": "Back in control", "duration": 45, "price": 50, "show_duration": True,
             "desc": "Een intuïtieve rugmassage waarbij op gevoel en volgens jouw noden de juiste massagetechnieken worden ingezet en knopen worden losgemaakt."},
            {"slug": "mind-control", "name": "Mind control", "duration": 30, "price": 40, "show_duration": True,
             "desc": "Een intuïtieve hoofdmassage, inclusief bodytapping en aromatherapie."},
        ],
    },
    {
        "id": "facials", "title": "Facials",
        "intro": "Gelaatsverzorging die ook je hoofd tot rust brengt: verzorging, aanraking en ademhaling in één moment.",
        "items": [
            {"slug": "inner-balance-facial", "name": "Inner balance facial", "duration": 60, "price": 75, "show_duration": True,
             "desc": "Deze facial staat naast verzorging ook centraal voor mentale rust. Tijdens de gelaatsverzorging wordt je geest gekalmeerd met een zachte hoofd-, nek- en schoudermassage, aromatherapie en intuïtieve aanrakingen. Een moment van helderheid, rust en verbinding met jezelf."},
            {"slug": "heart-harmony-facial", "name": "Heart harmony facial", "duration": 75, "price": 85, "show_duration": True,
             "desc": "Een zachte, liefdevolle behandeling waarin je hart de hoofdrol krijgt. De facial start met hartcoherentie, een rustgevende ademhalingstechniek die je helpt zakken in je lichaam en je zenuwstelsel ontspant. Daarna volgen een zachte gelaatsverzorging en een gezichtsmassage met lichte drukpunten langs kaak en slapen."},
            {"slug": "grounding-glow-facial", "name": "Grounding glow facial", "duration": 90, "price": 105, "show_duration": True,
             "desc": "Een zachte, voedende gelaatsbehandeling met een stevig collageenmasker, terwijl je rootchakra (het energiepunt voor veiligheid, stevigheid en zelfvertrouwen) aandacht krijgt. Tijdens de rustgevende voetmassage land je volledig terug in je lichaam."},
        ],
    },
]

JOURNEYS = [
    {"name": "Her Inner Harmony Journey", "tagline": "Een journey naar rust en balans",
     "steps": ["Intake + chakra-observatie (1u30)", "1-op-1 yoga", "Lichaamsmassage", "Nervous system reset-hoofdmassage", "Inner balance facial", "Reflectiemoment"]},
    {"name": "Her Feminine Flow Journey", "tagline": "Een journey naar zelfacceptatie en intuïtie",
     "steps": ["Intake + chakra-observatie (1u30)", "1-op-1 pilates", "Energetische lichaamsmassage", "Mindful hairflow-hoofdmassage", "Heart harmony facial", "Reflectiemoment"]},
    {"name": "Her Evolving Journey", "tagline": "Een journey naar innerlijke kracht en groei",
     "steps": ["Intake + chakra-observatie (1u30)", "1-op-1 BBB-workout", "Deep tissue-lichaamsmassage", "Emotional reset-hoofdmassage", "Grounding glow facial", "Reflectiemoment"]},
]

ALL_ITEMS = [dict(it, category=c["title"]) for c in CATEGORIES for it in c["items"]]

# ---------------------------------------------------------------------------
# 3. Kleine helpers
# ---------------------------------------------------------------------------
def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def price_txt(p):
    return "Gratis" if p == 0 else f"€ {p:.2f}".replace(".", ",")


def dur_txt(m):
    if m < 60:
        return f"{m} min"
    h, r = divmod(m, 60)
    return f"{h}u{r:02d}" if r else f"{h}u"


ICONS = {
    "arrow": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6"/></svg>',
    "phone": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
    "whatsapp": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21l1.7-4.6A8.5 8.5 0 1 1 8 19.6z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 1a4 4 0 0 1-2-2l1-1-1-2z"/></svg>',
    "mail": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
    "pin": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
    "instagram": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".6" fill="currentColor"/></svg>',
}


def img(name, alt, sizes, w, h, cls="", eager=False):
    """Responsieve afbeelding (WebP, twee breedtes). w/h = intrinsieke maat van de grote variant."""
    small_w = 640
    loading = 'fetchpriority="high"' if eager else 'loading="lazy" decoding="async"'
    return (f'<img src="{{BASE}}assets/img/{name}-lg.webp" '
            f'srcset="{{BASE}}assets/img/{name}-sm.webp {small_w}w, {{BASE}}assets/img/{name}-lg.webp {w}w" '
            f'sizes="{sizes}" width="{w}" height="{h}" alt="{esc(alt)}" {loading}{(" class=" + chr(34) + cls + chr(34)) if cls else ""}>')


IMG = {  # naam: (breedte, hoogte) van de -lg-variant
    "hero-strand": (1139, 733), "binnen-strand": (1095, 858), "journeys-strand": (1101, 853),
    "geurbeleving": (1114, 1703), "massage-rug": (1200, 1493), "massage-hoofd": (1200, 1777),
    "facial-masker": (1200, 1795), "reset-kaars": (1200, 2187),
}


def picture(name, alt, sizes, eager=False):
    w, h = IMG[name]
    return img(name, alt, sizes, w, h, eager=eager)


# ---------------------------------------------------------------------------
# 4. Gedeelde onderdelen
# ---------------------------------------------------------------------------
NAV = [("index.html", "Home"), ("behandelingen.html", "Behandelingen"), ("journeys.html", "Journeys"),
       ("over.html", "Over Aida"), ("contact.html", "Contact")]


def hours_list(cls="hours"):
    rows = []
    for dow in [1, 2, 3, 4, 5, 6, 0]:
        if dow in HOURS:
            o, c = HOURS[dow]
            rows.append(f'<li><span>{DAY_NAMES[dow]}</span><span>{o} – {c}</span></li>')
        else:
            rows.append(f'<li class="closed"><span>{DAY_NAMES[dow]}</span><span>Gesloten</span></li>')
    return f'<ul class="{cls}">' + "".join(rows) + "</ul>"


def hours_compact():
    return "<ul class=\"hours\">" + "".join(
        f'<li><span>{DAY_NAMES[d][:2]}</span> <span>{HOURS[d][0]} – {HOURS[d][1]}</span></li>' for d in [1, 3, 5, 6]) + "</ul>"


def wa_link(text="Hallo Aida, ik heb een vraag over een behandeling."):
    from urllib.parse import quote
    return f'https://wa.me/{SITE["whatsapp"]}?text={quote(text)}'


def contact_lines():
    s = SITE
    maps = "https://www.google.com/maps/search/?api=1&query=" + f'{s["street"]} {s["postal"]} {s["city"]}'.replace(" ", "+")
    return f"""<ul class="contact-lines">
  <li><a href="{wa_link()}" target="_blank" rel="noopener">{ICONS['whatsapp']}<span>WhatsApp<span class="visually-hidden"> (opent in nieuw venster)</span></span></a></li>
  <li><a href="tel:{s['phone_e164']}">{ICONS['phone']}<span>{s['phone_display']}</span></a></li>
  <li><!-- IN TE VULLEN: e-mailadres (ook in href) --><a href="mailto:{s['email']}">{ICONS['mail']}<span>{s['email']}</span></a></li>
  <li><a href="{maps}" target="_blank" rel="noopener">{ICONS['pin']}<span>{s['street']}, {s['postal']} {s['city']}<span class="visually-hidden"> (route in Google Maps, nieuw venster)</span></span></a></li>
  <li><a href="{s['instagram']}" target="_blank" rel="noopener">{ICONS['instagram']}<span>{s['instagram_handle']}<span class="visually-hidden"> op Instagram (nieuw venster)</span></span></a></li>
</ul>"""


def header(active):
    links = "".join(
        f'<a href="{{BASE}}{href}"{" aria-current=" + chr(34) + "page" + chr(34) if href == active else ""}>{label}</a>'
        for href, label in NAV)
    return f"""<a class="skip-link" href="#inhoud">Ga naar de inhoud</a>
<header class="site-header">
  <div class="container nav-inner">
    <a class="logo" href="{{BASE}}index.html" aria-label="Eluneya, naar de startpagina">ELUNEYA</a>
    <nav class="nav-links" aria-label="Hoofdmenu">{links}</nav>
    <a class="btn btn-dark nav-cta" href="{{BASE}}afspraak.html">Maak afspraak</a>
    <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="mobile-menu" aria-label="Menu openen"><span></span><span></span><span></span></button>
  </div>
  <nav class="mobile-menu" id="mobile-menu" aria-label="Mobiel menu">
    {links}
    <a class="btn btn-dark" href="{{BASE}}afspraak.html">Maak afspraak</a>
    <p class="menu-meta">{SITE['street']}, {SITE['city']} · op afspraak</p>
  </nav>
</header>"""


def footer():
    s = SITE
    menu = "".join(f'<li><a href="{{BASE}}{h}">{l}</a></li>' for h, l in NAV)
    return f"""<footer class="site-footer">
  <div class="container">
    <div class="footer-grid">
      <div class="footer-brand">
        <a class="logo" href="{{BASE}}index.html">ELUNEYA</a>
        <p>Massages, facials en journeys om terug te keren naar jezelf. Glow from the inside out.</p>
      </div>
      <div class="footer-col">
        <h2>Menu</h2>
        <ul>{menu}<li><a href="{{BASE}}afspraak.html">Maak afspraak</a></li></ul>
      </div>
      <div class="footer-col">
        <h2>Openingsuren</h2>
        {hours_compact()}
        <p style="margin-top:8px;font-size:.85rem">Enkel op afspraak.</p>
      </div>
      <div class="footer-col">
        <h2>Contact</h2>
        <ul>
          <li>{s['street']}<br>{s['postal']} {s['city']}</li>
          <li><a href="tel:{s['phone_e164']}">{s['phone_display']}</a></li>
          <li><a href="{wa_link()}" target="_blank" rel="noopener">WhatsApp</a></li>
          <li><!-- IN TE VULLEN: e-mailadres --><a href="mailto:{s['email']}">{s['email']}</a></li>
          <li><a href="{s['instagram']}" target="_blank" rel="noopener">Instagram</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <p>© <span data-year>2026</span> Eluneya · <!-- IN TE VULLEN: juridische naam -->{s['legal_name']} · {s['street']}, {s['postal']} {s['city']} · Ondernemings- en btw-nummer {s['vat_display']}</p>
      <nav aria-label="Juridisch"><a href="{{BASE}}privacy.html">Privacyverklaring</a><a href="{{BASE}}voorwaarden.html">Algemene voorwaarden</a></nav>
    </div>
  </div>
</footer>"""


def cta_band(title="Klaar om terug te keren naar jezelf?", text="Kies een behandeling en een moment dat bij je past, of start met een gratis intakegesprek.",
             btn_href="afspraak.html", btn="Maak afspraak", second=True):
    sec = (f'<a class="btn btn-outline-light" href="{wa_link()}" target="_blank" rel="noopener">{ICONS["whatsapp"]}Stuur een bericht</a>' if second else "")
    return f"""<section class="cta-band on-dark">
  <div class="container">
    <p class="eyebrow">Eluneya</p>
    <h2 class="reveal">{title}</h2>
    <p class="reveal d1">{text}</p>
    <div class="btn-group reveal d2"><a class="btn btn-light" href="{{BASE}}{btn_href}">{btn}</a>{sec}</div>
  </div>
</section>"""


# ---------------------------------------------------------------------------
# 5. Dynamische blokken voor pagina's
# ---------------------------------------------------------------------------
def services_menu():
    out = []
    for c in CATEGORIES:
        items = []
        for it in c["items"]:
            meta = [dur_txt(it["duration"])] if it["show_duration"] else []
            meta_html = f'<p class="meta">{" · ".join(meta)}</p>' if meta else ""
            desc = f'<p class="desc">{esc(it["desc"])}</p>' if it.get("desc") else ""
            inc = ""
            if it.get("includes"):
                inc = '<ul class="includes" aria-label="Inbegrepen">' + "".join(f"<li>{esc(x)}</li>" for x in it["includes"]) + "</ul>"
            todo = "" if it["show_duration"] else "<!-- CONTROLEREN: duur van deze behandeling (agenda rekent nu met " + str(it["duration"]) + " min) -->"
            items.append(f"""<article class="menu-item">{todo}
  <h3>{esc(it['name'])}</h3><p class="price">{price_txt(it['price'])}</p>
  {meta_html}{desc}{inc}
  <a class="arrow-link book" href="{{BASE}}afspraak.html?behandeling={it['slug']}">Boek {esc(it['name'])}{ICONS['arrow']}</a>
</article>""")
        out.append(f"""<section class="menu-category reveal" id="{c['id']}" aria-labelledby="h-{c['id']}">
  <div class="menu-category-head"><h2 id="h-{c['id']}">{c['title']}</h2><p>{c['intro']}</p></div>
  <div class="menu-list">{''.join(items)}</div>
</section>""")
    return "\n".join(out)


def journeys_html():
    out = []
    for i, j in enumerate(JOURNEYS, 1):
        steps = "".join(f"<li>{esc(s)}</li>" for s in j["steps"])
        out.append(f"""<article class="journey reveal d{i-1 if i > 1 else ''}">
  <span class="num">0{i}</span>
  <h2>{esc(j['name'])}</h2>
  <p class="tagline">{esc(j['tagline'])}</p>
  <ol aria-label="Wat de journey omvat">{steps}</ol>
  <a class="btn btn-outline" href="{wa_link('Hallo Aida, ik heb interesse in de ' + j['name'] + '.')}" target="_blank" rel="noopener">{ICONS['whatsapp']}Vraag info</a>
</article>""".replace('class="journey reveal d"', 'class="journey reveal"'))
    return "\n".join(out)


def booking_select():
    groups = []
    for c in CATEGORIES:
        opts = "".join(
            f'<option value="{it["slug"]}">{esc(it["name"])} — {price_txt(it["price"])}</option>' for it in c["items"])
        groups.append(f'<optgroup label="{esc(c["title"])}">{opts}</optgroup>')
    return '<option value="">Kies een behandeling</option>' + "".join(groups)


def price_range():
    paid = [it["price"] for it in ALL_ITEMS if it["price"] > 0]
    return f"€{min(paid)} – €{max(paid)}"


# ---------------------------------------------------------------------------
# 6. Structured data
# ---------------------------------------------------------------------------
def business_ld():
    s = SITE
    offers = [{
        "@type": "Offer", "price": f'{it["price"]:.2f}', "priceCurrency": "EUR",
        "itemOffered": {"@type": "Service", "name": it["name"], "category": it["category"]},
    } for it in ALL_ITEMS]
    data = {
        "@context": "https://schema.org",
        "@type": "HealthAndBeautyBusiness",
        "@id": s["domain"] + "/#bedrijf",
        "name": s["name"],
        "url": s["domain"] + "/",
        "description": "Massages, facials en begeleide journeys in Wevelgem, op afspraak. Lichaamsgerichte en energetische begeleiding door Aida.",
        "image": s["domain"] + "/og-image.jpg",
        "logo": s["domain"] + "/icon-512.png",
        "telephone": s["phone_e164"],
        "vatID": s["vat_id"],
        "priceRange": price_range(),
        "address": {"@type": "PostalAddress", "streetAddress": s["street"], "postalCode": s["postal"],
                    "addressLocality": s["city"], "addressCountry": s["country"]},
        "founder": {"@type": "Person", "name": s["owner"]},
        "sameAs": [s["instagram"]],
        "openingHoursSpecification": [
            {"@type": "OpeningHoursSpecification", "dayOfWeek": SCHEMA_DAYS[d], "opens": o, "closes": c}
            for d, (o, c) in sorted(HOURS.items(), key=lambda kv: (kv[0] or 7))],
        "hasOfferCatalog": {"@type": "OfferCatalog", "name": "Behandelingen", "itemListElement": offers},
    }
    # NB: e-mail bewust niet opgenomen zolang het adres niet ingevuld is.
    return json.dumps(data, ensure_ascii=False, indent=2)


def breadcrumb_ld(label, path):
    d = SITE["domain"]
    return json.dumps({
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": d + "/"},
            {"@type": "ListItem", "position": 2, "name": label, "item": d + "/" + path},
        ]}, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# 7. <head>
# ---------------------------------------------------------------------------
def head(meta, path):
    d = SITE["domain"]
    canonical = d + "/" + ("" if path == "index.html" else path)
    robots = '<meta name="robots" content="noindex, follow">' if meta.get("noindex") else ""
    ld = ""
    for block in meta.get("_ld", []):
        ld += f'\n  <script type="application/ld+json">\n{block}\n  </script>'
    preload_img = ""
    if meta.get("preload_hero"):
        preload_img = ('\n  <link rel="preload" as="image" href="{BASE}assets/img/hero-strand-lg.webp" '
                       'imagesrcset="{BASE}assets/img/hero-strand-sm.webp 640w, {BASE}assets/img/hero-strand-lg.webp 1139w" imagesizes="100vw" fetchpriority="high">')
    return f"""<!doctype html>
<html lang="nl-BE">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{esc(meta['title'])}</title>
  <meta name="description" content="{esc(meta['description'])}">
  {robots}
  <link rel="canonical" href="{canonical}">
  <meta name="theme-color" content="#ffffff">

  <meta property="og:type" content="website">
  <meta property="og:locale" content="nl_BE">
  <meta property="og:site_name" content="Eluneya">
  <meta property="og:title" content="{esc(meta.get('og_title', meta['title']))}">
  <meta property="og:description" content="{esc(meta['description'])}">
  <meta property="og:url" content="{canonical}">
  <meta property="og:image" content="{d}/og-image.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Eluneya — Glow from the inside out. Massages, facials en journeys in Wevelgem.">
  <meta name="twitter:card" content="summary_large_image">

  <link rel="icon" href="{{BASE}}favicon.ico" sizes="any">
  <link rel="icon" href="{{BASE}}favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="{{BASE}}apple-touch-icon.png">
  <link rel="manifest" href="{{BASE}}site.webmanifest">

  <link rel="preload" href="{{BASE}}assets/fonts/poppins-latin-300-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="{{BASE}}assets/fonts/cormorant-garamond-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>{preload_img}
  <link rel="stylesheet" href="{{BASE}}assets/css/style.css">
  <script>document.documentElement.classList.add('js');</script>
  <script src="{{BASE}}assets/js/main.js" defer></script>{meta.get('extra_head', '')}{ld}
</head>"""


# ---------------------------------------------------------------------------
# 8. Bouwen
# ---------------------------------------------------------------------------
def build_pages():
    blocks = {
        "SERVICES_MENU": services_menu,
        "JOURNEYS": journeys_html,
        "HOURS_LIST": hours_list,
        "CONTACT_LINES": contact_lines,
        "CTA_BAND": cta_band,
        "BOOKING_SELECT": booking_select,
        "WA_LINK": wa_link,
        "STREET": lambda: SITE["street"], "POSTAL": lambda: SITE["postal"], "CITY": lambda: SITE["city"],
        "PHONE": lambda: SITE["phone_display"], "PHONE_E164": lambda: SITE["phone_e164"],
        "EMAIL": lambda: SITE["email"], "VAT": lambda: SITE["vat_display"], "KBO": lambda: SITE["kbo"],
        "LEGAL_NAME": lambda: SITE["legal_name"], "INSTAGRAM": lambda: SITE["instagram"],
        "MIN_NOTICE": lambda: str(BOOKING["min_notice_hours"]),
        "ICON_ARROW": lambda: ICONS["arrow"], "ICON_WHATSAPP": lambda: ICONS["whatsapp"], "ICON_PHONE": lambda: ICONS["phone"],
    }
    pic_re = re.compile(r"\{\{PIC (\S+) \"([^\"]*)\" \"([^\"]*)\"( eager)?\}\}")
    cta_re = re.compile(r"\{\{CTA_BAND (\{.*?\})\}\}", re.S)

    for src in sorted(SRC.glob("*.html")):
        raw = src.read_text(encoding="utf-8")
        m = re.match(r"\s*<!--meta\s*(\{.*?\})\s*-->\s*", raw, re.S)
        meta = json.loads(m.group(1))
        body = raw[m.end():]
        path = src.name
        base = "/" if path == "404.html" else ""

        ld = []
        if meta.get("ld_business"):
            ld.append(business_ld())
        if meta.get("breadcrumb"):
            ld.append(breadcrumb_ld(meta["breadcrumb"], path))
        meta["_ld"] = ld
        if meta.get("booking"):
            meta["extra_head"] = ('\n  <script src="{BASE}assets/js/config.js" defer></script>'
                                  '\n  <script src="{BASE}assets/js/services.js" defer></script>'
                                  '\n  <script src="{BASE}assets/js/booking.js" defer></script>')

        body = pic_re.sub(lambda mm: picture(mm.group(1), mm.group(2), mm.group(3), bool(mm.group(4))), body)
        body = cta_re.sub(lambda mm: cta_band(**json.loads(mm.group(1))), body)
        for key, fn in blocks.items():
            body = body.replace("{{" + key + "}}", fn())
        left = re.findall(r"\{\{[A-Z_ ]+.*?\}\}", body)
        if left:
            raise SystemExit(f"{path}: onvervangen blokken {left}")

        body_cls = meta.get("body_class", "")
        html = (head(meta, path) + f'\n<body{" class=" + chr(34) + body_cls + chr(34) if body_cls else ""}>\n'
                + header(path if path != "afspraak.html" else "") + "\n" + body.strip() + "\n" + footer() + "\n</body>\n</html>\n")
        html = html.replace("{BASE}", base)
        html = re.sub(r"\n\s*\n\s*\n", "\n\n", html)
        (OUT / path).write_text(html, encoding="utf-8")
        print("gebouwd:", path)


def build_services_js():
    data = {
        "services": [{"slug": it["slug"], "name": it["name"], "category": it["category"], "duration": it["duration"],
                      "price": it["price"], "showDuration": it["show_duration"]} for it in ALL_ITEMS],
        "openingHours": {str(k): list(v) for k, v in HOURS.items()},
        "rules": {"slotStep": BOOKING["slot_step"], "bufferMinutes": BOOKING["buffer_minutes"],
                  "minNoticeHours": BOOKING["min_notice_hours"], "maxDaysAhead": BOOKING["max_days_ahead"]},
        "contact": {"whatsapp": SITE["whatsapp"], "phoneDisplay": SITE["phone_display"], "phoneE164": SITE["phone_e164"],
                    "address": f'{SITE["street"]}, {SITE["postal"]} {SITE["city"]}'},
    }
    js = ("/* GEGENEREERD door src/build.py — niet met de hand aanpassen.\n"
          "   Behandelingen, openingsuren en boekingsregels (gelijk aan supabase/schema.sql). */\n"
          "window.ELUNEYA_DATA = " + json.dumps(data, ensure_ascii=False, indent=2) + ";\n")
    (OUT / "assets/js/services.js").write_text(js, encoding="utf-8")
    print("gebouwd: assets/js/services.js")


def build_sql_seed():
    """Vult de seed-blokken in supabase/schema.sql met dezelfde gegevens als de site."""
    sql_path = ROOT / "supabase" / "schema.sql"
    sql = sql_path.read_text(encoding="utf-8")
    svc = ",\n".join(
        f"  ('{it['slug']}', '{it['name'].replace(chr(39), chr(39) * 2)}', {it['duration']}, {it['price']:.2f})" for it in ALL_ITEMS)
    hrs = ",\n".join(f"  ({d}, '{o}', '{c}')" for d, (o, c) in sorted(HOURS.items()))
    settings = (f"  buffer_minutes := {BOOKING['buffer_minutes']};\n  min_notice_hours := {BOOKING['min_notice_hours']};\n"
                f"  max_days_ahead := {BOOKING['max_days_ahead']};\n  max_open_per_email := {BOOKING['max_open_per_email']};\n  slot_step := {BOOKING['slot_step']};")
    def fill(text, tag, content, indent=""):
        pat = re.compile(r"(" + indent + "-- @" + tag + r"-start\n)(?:.*?\n)?(" + indent + "-- @" + tag + "-end)", re.S)
        if not pat.search(text):
            raise SystemExit("schema.sql: markering @" + tag + " niet gevonden")
        return pat.sub(lambda m: m.group(1) + content + "\n" + m.group(2), text)
    sql = fill(sql, "services", svc)
    sql = fill(sql, "hours", hrs)
    sql = fill(sql, "settings", settings, "  ")
    sql_path.write_text(sql, encoding="utf-8")
    print("bijgewerkt: supabase/schema.sql")


def build_seo_files():
    d = SITE["domain"]
    pages = [("index.html", "1.0"), ("behandelingen.html", "0.9"), ("afspraak.html", "0.9"), ("journeys.html", "0.8"),
             ("over.html", "0.7"), ("contact.html", "0.8"), ("privacy.html", "0.2"), ("voorwaarden.html", "0.2")]
    import datetime
    today = datetime.date.today().isoformat()
    urls = "".join(
        f"  <url><loc>{d}/{'' if p == 'index.html' else p}</loc><lastmod>{today}</lastmod><priority>{pr}</priority></url>\n"
        for p, pr in pages)
    (OUT / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n'
                                     '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + "</urlset>\n", encoding="utf-8")
    (OUT / "robots.txt").write_text(f"User-agent: *\nAllow: /\n\nSitemap: {d}/sitemap.xml\n", encoding="utf-8")
    manifest = {
        "name": "Eluneya", "short_name": "Eluneya", "lang": "nl-BE",
        "description": "Massages, facials en journeys in Wevelgem.",
        "start_url": "/", "display": "browser", "background_color": "#ffffff", "theme_color": "#ffffff",
        "icons": [{"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
                  {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"},
                  {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}],
    }
    (OUT / "site.webmanifest").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("gebouwd: sitemap.xml, robots.txt, site.webmanifest")


if __name__ == "__main__":
    build_pages()
    build_services_js()
    build_sql_seed()
    build_seo_files()
