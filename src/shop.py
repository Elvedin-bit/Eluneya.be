"""Webshop voor de Eluneya-website: catalogus, statische shop-/categorie-/productpagina's, navigatie en SEO.

Wordt aangeroepen door build.py. De catalogus komt uit src/catalog.json (een momentopname van de
Supabase-tabellen; leeg zolang er geen producten zijn). Zo staan er statische, indexeerbare pagina's:
    /shop/                      overzicht met filters
    /shop/<categorie>/          categoriepagina
    /shop/<categorie>/<slug>/   productpagina (met Product-structured data)
De pagina's blijven ook zonder JavaScript leesbaar; shop.js en product.js voegen filters,
actuele prijzen/voorraad en de winkelmand toe.

Catalogus vernieuwen vanuit Supabase (enkel publieke leesrechten, anon-sleutel uit config.js):
    python3 src/build.py --fetch-catalog
Zolang catalog.json geen producten bevat, is de shop onzichtbaar (geen menu-item, geen winkelmand,
geen pagina's in de sitemap) — de website blijft dus exact zoals voorheen.
"""
import datetime
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG_FILE = Path(os.environ["ELUNEYA_CATALOG"]) if os.environ.get("ELUNEYA_CATALOG") else ROOT / "src" / "catalog.json"

# Zelfde namen als de basiscategorieën in supabase/shop.sql (volgorde = volgorde in menu en filters).
EMPTY = {"generated": None, "categories": [], "brands": [], "products": []}


# ---------------------------------------------------------------------------
# Catalogus laden / vernieuwen
# ---------------------------------------------------------------------------
def _config():
    if os.environ.get("ELUNEYA_SUPABASE_URL"):   # enkel voor tests: een testomgeving i.p.v. de URL uit config.js
        return os.environ["ELUNEYA_SUPABASE_URL"].rstrip("/"), os.environ.get("ELUNEYA_SUPABASE_KEY", "")
    txt = (ROOT / "site" / "assets" / "js" / "config.js").read_text(encoding="utf-8")
    url = re.search(r"supabaseUrl:\s*'([^']+)'", txt).group(1).rstrip("/")
    key = re.search(r"supabaseKey:\s*'([^']+)'", txt).group(1)
    return url, key


def fetch_catalog():
    """Leest de publiek zichtbare catalogus uit Supabase (alleen leesrechten) en bewaart ze in catalog.json."""
    url, key = _config()
    headers = {"apikey": key, "Accept": "application/json"}
    if key.startswith("eyJ"):
        headers["Authorization"] = "Bearer " + key

    def get(q):
        with urllib.request.urlopen(urllib.request.Request(f"{url}/rest/v1/{q}", headers=headers), timeout=30) as r:
            return json.load(r)

    cats = get("product_categories?select=id,slug,name,description,attribute_set,sort_order&order=sort_order")
    brands = get("brands?select=id,slug,name")
    rows = get("products?select=id,slug,category_id,brand_id,name,short_description,description,ingredients,content_label,product_type,"
               "sku,price_eur,compare_at_price_eur,sale_price_eur,sale_starts_at,sale_ends_at,availability,is_available,is_featured,"
               "sort_order,created_at,updated_at,product_images(url,alt,sort_order,is_primary),product_attributes(data),"
               "product_variants(id,label,volume_ml,sku,price_eur,sort_order,is_available)&order=sort_order")
    return normalise(cats, brands, rows)


def normalise(cats, brands, rows):
    cat_slug = {c["id"]: c["slug"] for c in cats}
    brand_name = {b["id"]: b["name"] for b in brands}
    products = []
    for r in rows:
        imgs = sorted(r.get("product_images") or [], key=lambda i: (not i["is_primary"], i["sort_order"]))
        attrs = r.get("product_attributes")
        attrs = attrs[0]["data"] if isinstance(attrs, list) and attrs else (attrs or {}).get("data", {}) if isinstance(attrs, dict) else {}
        products.append({
            "id": r["id"], "slug": r["slug"], "category": cat_slug.get(r["category_id"]), "brand": brand_name.get(r["brand_id"]),
            "name": r["name"], "short": r.get("short_description"), "description": r.get("description"),
            "ingredients": r.get("ingredients"), "content": r.get("content_label"), "type": r["product_type"], "sku": r.get("sku"),
            "price": float(r["price_eur"]),
            "compare_at": float(r["compare_at_price_eur"]) if r.get("compare_at_price_eur") is not None else None,
            "sale_price": float(r["sale_price_eur"]) if r.get("sale_price_eur") is not None else None,
            "sale_starts": r.get("sale_starts_at"), "sale_ends": r.get("sale_ends_at"),
            "availability": r["availability"], "available": bool(r["is_available"]), "featured": bool(r["is_featured"]),
            "sort": r["sort_order"], "created": r.get("created_at"), "updated": r.get("updated_at"),
            "images": [{"url": i["url"], "alt": i.get("alt")} for i in imgs],
            "attributes": attrs or {},
            "variants": [{"id": v["id"], "label": v["label"], "volume": float(v["volume_ml"]) if v.get("volume_ml") is not None else None,
                          "sku": v.get("sku"), "price": float(v["price_eur"]) if v.get("price_eur") is not None else None,
                          "available": bool(v["is_available"])}
                         for v in sorted(r.get("product_variants") or [], key=lambda v: v["sort_order"])],
        })
    return {"generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "categories": [{k: c[k] for k in ("slug", "name", "description", "attribute_set", "sort_order")} for c in cats],
            "brands": [{"slug": b["slug"], "name": b["name"]} for b in brands], "products": products}


def load_catalog():
    if "--fetch-catalog" in sys.argv or os.environ.get("ELUNEYA_FETCH_CATALOG") == "1":
        cat = fetch_catalog()
        CATALOG_FILE.write_text(json.dumps(cat, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"catalogus vernieuwd: {len(cat['products'])} producten")
        return cat
    if CATALOG_FILE.exists():
        return json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
    return dict(EMPTY)


CATALOG = load_catalog()
CATS = {c["slug"]: c for c in sorted(CATALOG["categories"], key=lambda c: c["sort_order"])}
PRODUCTS = sorted(CATALOG["products"], key=lambda p: (CATS.get(p["category"], {}).get("sort_order", 999), p["sort"], p["name"]))
LIVE_CATS = [c for c in CATS.values() if any(p["category"] == c["slug"] for p in PRODUCTS)]   # enkel categorieën met producten


def visible():
    """De shop verschijnt pas in het menu als er minstens één product is."""
    return bool(PRODUCTS)


# ---------------------------------------------------------------------------
# Hulpfuncties
# ---------------------------------------------------------------------------
def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def eur(x):
    return f"€ {x:.2f}".replace(".", ",")


def _parse(ts):
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None


def sale_active(p, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if p.get("sale_price") is None:
        return False
    s, e = _parse(p.get("sale_starts")), _parse(p.get("sale_ends"))
    return (s is None or now >= s) and (e is None or now <= e)


def price_now(p):
    return p["sale_price"] if sale_active(p) else p["price"]


def url_of(p):
    return f"/shop/{p['category']}/{p['slug']}/"


def abs_url(u, domain):
    return u if u.startswith("http") else domain + u


def image_of(p):
    return p["images"][0] if p["images"] else None


def cat_name(slug):
    return CATS.get(slug, {}).get("name", "Shop")


def short_text(p, n=155):
    t = re.sub(r"\s+", " ", (p.get("short") or p.get("description") or "")).strip()
    return t if len(t) <= n else t[: n - 1].rsplit(" ", 1)[0] + "…"


def status(p):
    """(css-klasse, tekst) voor beschikbaarheid."""
    a = p["availability"]
    if a == "out_of_stock":
        return "out", "Uitverkocht"
    if a == "on_request":
        return "request", "Enkel op aanvraag"
    if has_variants(p):   # de voorraad zit per variant: uitverkocht als geen enkele variant nog beschikbaar is
        if not any(v["available"] for v in p["variants"]):
            return "out", "Uitverkocht"
    elif not p["available"] and a == "in_stock":
        return "out", "Uitverkocht"
    if a == "preorder":
        return "preorder", "Voorbestellen"
    return "in", "Op voorraad"


def has_variants(p):
    return bool(p.get("variants"))


def default_variant(p):
    """De vooraf gekozen variant: de eerste beschikbare."""
    return next((v for v in p.get("variants") or [] if v["available"]), None)


def variant_price(p, v):
    """Actuele prijs van een variant: eigen prijs, anders de (actie)prijs van het product."""
    return v["price"] if v is not None and v.get("price") is not None else price_now(p)


def sale_applies(p):
    """Actieprijs geldt enkel voor varianten zonder eigen prijs."""
    if not sale_active(p):
        return False
    return not has_variants(p) or any(v["available"] and v.get("price") is None for v in p["variants"])


def from_price(p):
    if not has_variants(p):
        return price_now(p)
    live = [v for v in p["variants"] if v["available"]] or p["variants"]
    return min(variant_price(p, v) for v in live)


# ---------------------------------------------------------------------------
# Menu en winkelmand
# ---------------------------------------------------------------------------
ICON_BAG = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" '
            'aria-hidden="true"><path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>')


def nav_item(active, mobile=False):
    subs = "".join(f'<a href="{{BASE}}shop/{c["slug"]}/">{esc(c["name"])}</a>' for c in LIVE_CATS)
    cur = ' aria-current="page"' if active else ""
    if mobile:
        return (f'<a href="{{BASE}}shop/"{cur}>Shop</a>'
                f'<div class="menu-sub">{subs}</div>' if len(LIVE_CATS) > 1 else f'<a href="{{BASE}}shop/"{cur}>Shop</a>')
    if len(LIVE_CATS) <= 1:
        return f'<a href="{{BASE}}shop/"{cur}>Shop</a>'
    return (f'<div class="nav-item has-sub"><a href="{{BASE}}shop/"{cur}>Shop</a>'
            f'<div class="subnav"><a href="{{BASE}}shop/">Alle producten</a>{subs}</div></div>')


def cart_link():
    return (f'\n    <a class="cart-link" href="{{BASE}}winkelmand.html" aria-label="Winkelmand">{ICON_BAG}'
            '<span class="cart-count" data-cart-count hidden>0</span></a>')


# ---------------------------------------------------------------------------
# Bouwstenen voor pagina's
# ---------------------------------------------------------------------------
def badges(p):
    out = []
    if sale_applies(p):
        out.append(f'<span class="p-badge sale">−{round((1 - p["sale_price"] / p["price"]) * 100)}%</span>')
    cls, txt = status(p)
    if cls in ("out", "request", "preorder"):
        out.append(f'<span class="p-badge {cls}">{txt}</span>')
    return f'<span class="p-badges">{"".join(out)}</span>' if out else ""


def price_html(p, big=False, v=None):
    now = variant_price(p, v)
    if v is not None and v.get("price") is not None:
        return f'<p class="p-price{" big" if big else ""}"><strong class="p-now">{eur(now)}</strong></p>'
    if sale_active(p):
        old = f'<s class="p-was"><span class="visually-hidden">Normale prijs </span>{eur(p["price"])}</s> '
        return f'<p class="p-price{" big" if big else ""}">{old}<strong class="p-now"><span class="visually-hidden">Nu </span>{eur(now)}</strong></p>'
    if p.get("compare_at"):
        return (f'<p class="p-price{" big" if big else ""}"><s class="p-was"><span class="visually-hidden">Oude prijs </span>{eur(p["compare_at"])}</s> '
                f'<strong class="p-now">{eur(now)}</strong></p>')
    return f'<p class="p-price{" big" if big else ""}"><strong class="p-now">{eur(now)}</strong></p>'


def media(p, cls="", eager=False):
    im = image_of(p)
    if not im:
        return f'<div class="p-media p-noimg {cls}" aria-hidden="true"><span>{esc(p["name"][:1])}</span></div>'
    load = 'fetchpriority="high"' if eager else 'loading="lazy" decoding="async"'
    return (f'<div class="p-media {cls}"><img src="{esc(im["url"])}" alt="{esc(im.get("alt") or p["name"])}" '
            f'width="800" height="1000" {load}></div>')


def card_price(p):
    """Prijs op een productkaart: "vanaf" als de varianten verschillende prijzen hebben."""
    if not has_variants(p):
        return price_html(p)
    live = [v for v in p["variants"] if v["available"]] or p["variants"]
    prices = [variant_price(p, v) for v in live]
    if min(prices) == max(prices):
        return price_html(p, v=live[0])
    return f'<p class="p-price"><span class="p-from">vanaf</span> <strong class="p-now">{eur(min(prices))}</strong></p>'


def variants_html(p):
    """Keuze van de inhoud op de productpagina (de eerste beschikbare staat voorgeselecteerd)."""
    if not has_variants(p):
        return ""
    dv = default_variant(p)
    opts = "".join(
        f'<label class="variant-opt{"" if v["available"] else " is-out"}"><input type="radio" name="variant" value="{v["id"]}"'
        f'{" checked" if dv and dv["id"] == v["id"] else ""}{"" if v["available"] else " disabled"}>'
        f'<span class="v-name">{esc(v["label"])}</span><span class="v-price">{eur(variant_price(p, v)) if v["available"] else "Uitverkocht"}</span></label>'
        for v in p["variants"])
    return f'<fieldset class="variants" data-variants><legend>Inhoud</legend><div class="variant-grid">{opts}</div></fieldset>'


def card(p, d=0):
    attrs = p.get("attributes") or {}
    sizes = " · ".join(v["label"] for v in p["variants"][:4]) if has_variants(p) else p.get("content")
    meta = " · ".join(x for x in [sizes, attrs.get("fragrance_family")] if x)
    cls, _ = status(p)
    return f"""<article class="p-card reveal{f' d{d}' if d else ''}" data-id="{p['id']}" data-cat="{esc(p['category'])}" data-brand="{esc(p.get('brand') or '')}" data-family="{esc(attrs.get('fragrance_family') or '')}" data-price="{from_price(p):.2f}" data-featured="{int(p['featured'])}" data-in="{int(cls in ('in', 'preorder'))}" data-name="{esc(p['name'].lower())}">
  <a class="p-card-link" href="{url_of(p)}">
    <div class="p-media-wrap">{media(p, "ratio-portrait")}{badges(p)}</div>
    <div class="p-card-body">
      {f'<p class="p-brand">{esc(p["brand"])}</p>' if p.get('brand') else ''}
      <h3 class="p-name">{esc(p['name'])}</h3>
      {f'<p class="p-meta">{esc(meta)}</p>' if meta else ''}
      {card_price(p)}
    </div>
  </a>
</article>"""


def grid(products):
    if not products:
        return '<p class="shop-empty">Binnenkort vind je hier onze producten.</p>'
    return '<div class="p-grid" id="shop-grid">' + "".join(card(p, i % 4) for i, p in enumerate(products)) + "</div>"


def breadcrumb_ld(domain, trail):
    return json.dumps({"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": i, "name": n, "item": domain + u} for i, (n, u) in enumerate(trail, 1)]}, ensure_ascii=False, indent=2)


def product_ld(p, domain):
    cls, _ = status(p)
    avail = {"in": "InStock", "out": "OutOfStock", "preorder": "PreOrder", "request": "LimitedAvailability"}[cls]
    offer = {"@type": "Offer", "url": domain + url_of(p), "priceCurrency": "EUR", "price": f"{from_price(p):.2f}",
             "availability": "https://schema.org/" + avail, "itemCondition": "https://schema.org/NewCondition",
             "seller": {"@id": domain + "/#bedrijf"}}
    if sale_active(p) and p.get("sale_ends"):
        offer["priceValidUntil"] = p["sale_ends"][:10]
    prices = [variant_price(p, v) for v in p.get("variants") or []]
    if prices and (min(prices) != max(prices)):   # varianten met verschillende prijzen: prijsrange i.p.v. één prijs
        offer = {"@type": "AggregateOffer", "url": offer["url"], "priceCurrency": "EUR", "lowPrice": f"{min(prices):.2f}",
                 "highPrice": f"{max(prices):.2f}", "offerCount": len(p["variants"]), "availability": offer["availability"],
                 "itemCondition": offer["itemCondition"], "seller": offer["seller"]}
    data = {"@context": "https://schema.org", "@type": "Product", "@id": domain + url_of(p) + "#product", "name": p["name"],
            "description": short_text(p, 300) or p["name"], "category": cat_name(p["category"]), "offers": offer}
    if p.get("sku"):
        data["sku"] = p["sku"]
    if p.get("brand"):
        data["brand"] = {"@type": "Brand", "name": p["brand"]}
    if p["images"]:
        data["image"] = [abs_url(i["url"], domain) for i in p["images"]]
    return json.dumps(data, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Pagina's
# ---------------------------------------------------------------------------
def chips(active_cat, mode):
    items = [("", "Alles", "/shop/")] + [(c["slug"], c["name"], f'/shop/{c["slug"]}/') for c in LIVE_CATS]
    return ('<div class="chips" role="group" aria-label="Categorie">' + "".join(
        f'<a class="chip" href="{{BASE}}{u.lstrip("/")}" data-cat="{s}"{" aria-current=" + chr(34) + "true" + chr(34) if s == active_cat else ""}>{esc(n)}</a>'
        for s, n, u in items) + "</div>")


def toolbar(active_cat):
    brands = sorted({p["brand"] for p in PRODUCTS if p.get("brand")})
    fams = sorted({(p.get("attributes") or {}).get("fragrance_family") for p in PRODUCTS} - {None, ""})
    brand_sel = ('<div class="field"><label for="shop-brand">Merk</label><select class="select" id="shop-brand"><option value="">Alle merken</option>'
                 + "".join(f'<option>{esc(b)}</option>' for b in brands) + "</select></div>") if len(brands) > 1 else ""
    fam_sel = ('<div class="field"><label for="shop-family">Geurfamilie</label><select class="select" id="shop-family"><option value="">Alle geuren</option>'
               + "".join(f'<option>{esc(f)}</option>' for f in fams) + "</select></div>") if fams else ""
    return f"""<form class="shop-toolbar" id="shop-toolbar" role="search" aria-label="Producten filteren" onsubmit="return false">
    {chips(active_cat, "")}
    <div class="shop-controls">
      <div class="field"><label for="shop-search">Zoeken</label><input class="input" id="shop-search" type="search" placeholder="Zoek een product of geur" autocomplete="off"></div>
      {brand_sel}{fam_sel}
      <div class="field"><label for="shop-sort">Sorteren</label><select class="select" id="shop-sort">
        <option value="featured">Aanbevolen</option><option value="new">Nieuw</option><option value="price-asc">Prijs: laag naar hoog</option>
        <option value="price-desc">Prijs: hoog naar laag</option><option value="name">Naam A–Z</option></select></div>
      <label class="check shop-instock"><input type="checkbox" id="shop-instock"><span>Enkel op voorraad</span></label>
    </div>
    <p class="shop-count" id="shop-count" aria-live="polite"></p>
  </form>"""


def listing_page(cat=None):
    slug = cat["slug"] if cat else ""
    items = [p for p in PRODUCTS if not cat or p["category"] == slug]
    title = cat["name"] if cat else "Shop"
    intro = (cat.get("description") if cat else None) or "Zorgvuldig gekozen parfums en producten, met dezelfde aandacht als in de praktijk."
    featured = [p for p in PRODUCTS if p["featured"]][:4] if not cat else []
    feat_html = (f'<section class="section-tight" aria-labelledby="feat-title"><div class="container"><h2 class="h-sub" id="feat-title">Uitgelicht</h2>'
                 f'<div class="p-grid p-grid-feat">{"".join(card(p, i) for i, p in enumerate(featured))}</div></div></section>') if len(PRODUCTS) > 4 and featured else ""
    path = f"shop/{slug}/index.html" if cat else "shop/index.html"
    meta = {
        "title": f"{title} — Eluneya Wevelgem" if cat else "Shop — parfums & wellness | Eluneya",
        "description": intro if len(intro) <= 155 else intro[:154].rsplit(" ", 1)[0] + "…",
        "styles": ["shop.css"],
        "extra_head": '\n  <script src="{BASE}assets/js/catalog.js" defer></script>\n  <script src="{BASE}assets/js/shop.js" defer></script>',
        "_trail": [("Home", "/"), ("Shop", "/shop/")] + ([(title, f"/shop/{slug}/")] if cat else []),
    }
    body = f"""<main id="inhoud" class="shop" data-shop-mode="{'category' if cat else 'index'}" data-shop-cat="{slug}">
  <section class="page-hero shop-hero" aria-labelledby="page-title">
    <div class="container">
      <p class="eyebrow">{'Shop' if not cat else 'Shop · ' + esc(title)}</p>
      <h1 class="h-display" id="page-title">{esc(title) if cat else 'Parfums &amp; meer, met aandacht gekozen'}</h1>
      <p class="lead">{esc(intro)}</p>
    </div>
  </section>
  {feat_html if not cat else ''}
  <section class="section-tight" aria-label="Producten">
    <div class="container">
      {toolbar(slug)}
      <div id="shop-results">{grid(items)}</div>
      <p class="shop-empty" id="shop-none" hidden>Geen producten gevonden. Probeer een andere zoekopdracht of filter.</p>
    </div>
  </section>
  <section class="shop-note"><div class="container"><p>Je plaatst een bestelaanvraag; Aida bevestigt ze en spreekt betaling en afhalen of verzenden met je af. Prijzen zijn inclusief btw.</p></div></section>
  @@CTA@@
</main>"""
    return path, meta, body, "shop"


def notes_html(p):
    n = (p.get("attributes") or {}).get("notes") or {}
    cols = [("top", "Topnoten", "De eerste indruk, de eerste minuten."), ("heart", "Hartnoten", "Het karakter van de geur."),
            ("base", "Basisnoten", "Blijft uren op de huid.")]
    out = ""
    for k, lab, sub in cols:
        if n.get(k):
            out += (f'<div class="note-tier"><h3>{lab}</h3><p class="note-sub">{sub}</p><ul class="chips-static">'
                    + "".join(f"<li>{esc(x)}</li>" for x in n[k]) + "</ul></div>")
    return f'<div class="notes">{out}</div>' if out else ""


def notes_line(p):
    n = (p.get("attributes") or {}).get("notes") or {}
    parts = [f'<span><b>{lab}</b> {esc(", ".join(n[k]))}</span>' for k, lab in (("top", "Top"), ("heart", "Hart"), ("base", "Basis")) if n.get(k)]
    return f'<p class="notes-line">{"".join(parts)}</p>' if parts else ""


def gallery(p):
    if not p["images"]:
        return media(p, "ratio-portrait", eager=True)
    main = media(p, "ratio-portrait", eager=True).replace('class="p-media', 'id="gallery-main" class="p-media', 1)
    thumbs = ""
    if len(p["images"]) > 1:
        thumbs = '<div class="gallery-thumbs" role="group" aria-label="Meer foto\'s">' + "".join(
            f'<button type="button" data-src="{esc(i["url"])}" data-alt="{esc(i.get("alt") or p["name"])}" aria-label="Foto {n}"'
            f'{" aria-current=" + chr(34) + "true" + chr(34) if n == 1 else ""}><img src="{esc(i["url"])}" alt="" width="96" height="120" loading="lazy"></button>'
            for n, i in enumerate(p["images"], 1)) + "</div>"
    return main + thumbs


def product_page(p, wa_link):
    attrs = p.get("attributes") or {}
    cls, stat_txt = status(p)
    cat = CATS.get(p["category"], {"name": "Shop", "slug": p["category"]})
    can_buy = cls in ("in", "preorder")
    var_html = variants_html(p)
    dv = default_variant(p)
    sizes_txt = ", ".join(v["label"] for v in p["variants"]) if has_variants(p) else p.get("content")
    facts = [("Inhoud", sizes_txt), ("Geurfamilie", attrs.get("fragrance_family")), ("Concentratie", attrs.get("concentration")),
             ("Merk", p.get("brand")), ("Productcode", p.get("sku")), ("Categorie", cat["name"])]
    facts_html = "".join(f"<div><dt>{k}</dt><dd>{esc(v)}</dd></div>" for k, v in facts if v)
    if can_buy:
        buy = f"""<div class="buy" data-buy>
        {var_html}
        <div class="buy-row">
          <div class="qty" role="group" aria-label="Aantal"><button type="button" data-qty-minus aria-label="Minder">−</button>
            <input type="number" id="p-qty" value="1" min="1" max="10" inputmode="numeric" aria-label="Aantal"><button type="button" data-qty-plus aria-label="Meer">+</button></div>
          <button class="btn btn-dark buy-btn" type="button" data-add>Toevoegen aan winkelmand</button>
        </div>
        <p class="buy-msg" role="status" aria-live="polite" data-msg></p>
        <noscript><p class="fineprint">Zonder JavaScript kun je niet via de winkelmand bestellen: stuur Aida een <a class="text-link" href="{wa_link('Hallo Aida, ik wil graag ' + p['name'] + ' bestellen.')}">bericht</a>.</p></noscript>
      </div>"""
    else:
        ask = "Dit product is enkel op aanvraag beschikbaar." if cls == "request" else "Momenteel uitverkocht."
        buy = (f'<div class="buy"><p class="buy-msg is-info">{ask}</p><a class="btn btn-outline" href="'
               f'{wa_link("Hallo Aida, ik heb interesse in " + p["name"] + ".")}" target="_blank" rel="noopener">Vraag het aan Aida</a></div>')
    sections = []
    if notes_html(p):
        sections.append(("Geurprofiel", notes_html(p) + (f'<p class="p-fam">Geurfamilie: <strong>{esc(attrs["fragrance_family"])}</strong></p>' if attrs.get("fragrance_family") else "")))
    if p.get("description"):
        sections.append(("Beschrijving", "".join(f"<p>{esc(x)}</p>" for x in p["description"].split("\n\n"))))
    sections.append(("Details", f'<dl class="facts">{facts_html}</dl>'))
    if p.get("ingredients"):
        sections.append(("Ingrediënten", f"<p>{esc(p['ingredients'])}</p>"))
    sections.append(("Bestellen &amp; levering", "<p>Je plaatst een bestelaanvraag. Aida bevestigt ze, en spreekt betaling en afhalen of verzenden met je af via WhatsApp of e-mail. Prijzen zijn inclusief btw.</p>"))
    acc = "".join(f'<details class="acc"{" open" if i == 0 else ""}><summary>{t}</summary><div class="acc-body">{b}</div></details>' for i, (t, b) in enumerate(sections))
    same = [x for x in PRODUCTS if x["category"] == p["category"] and x["id"] != p["id"]][:4]
    other = [x for x in PRODUCTS if x["category"] != p["category"] and x["featured"]][:4]
    rel = ""
    if same:
        rel += f'<section class="section-tight" aria-labelledby="rel1"><div class="container"><h2 class="h-sub" id="rel1">Meer uit {esc(cat["name"].lower())}</h2><div class="p-grid">{"".join(card(x, i) for i, x in enumerate(same))}</div></div></section>'
    if other:
        rel += f'<section class="section-tight" aria-labelledby="rel2"><div class="container"><h2 class="h-sub" id="rel2">Ook mooi</h2><div class="p-grid">{"".join(card(x, i) for i, x in enumerate(other))}</div></div></section>'
    im = image_of(p)
    meta = {
        "title": f"{p['name']}{' ' + p['content'] if p.get('content') and not has_variants(p) else ''}{' — ' + p['brand'] if p.get('brand') else ''} | Eluneya",
        "description": short_text(p) or f"{p['name']} bij Eluneya in Wevelgem.",
        "styles": ["shop.css"], "og_type": "product",
        "extra_head": '\n  <script src="{BASE}assets/js/catalog.js" defer></script>\n  <script src="{BASE}assets/js/product.js" defer></script>',
        "_trail": [("Home", "/"), ("Shop", "/shop/"), (cat["name"], f"/shop/{cat['slug']}/"), (p["name"], url_of(p))],
        "_extra_ld": [product_ld(p, "{DOMAIN}")],
    }
    if im:
        meta["og_image"] = "{DOMAIN}" + im["url"] if im["url"].startswith("/") else im["url"]
        meta["og_image_alt"] = im.get("alt") or p["name"]
    eyebrow = esc(p["brand"]) if p.get("brand") else esc(cat["name"])
    body = f"""<main id="inhoud" class="shop product" data-product-id="{p['id']}" data-product-slug="{esc(p['slug'])}">
  <div class="container">
    <nav class="crumbs" aria-label="Kruimelpad"><a href="{{BASE}}shop/">Shop</a><span aria-hidden="true">/</span><a href="{{BASE}}shop/{cat['slug']}/">{esc(cat['name'])}</a><span aria-hidden="true">/</span><span aria-current="page">{esc(p['name'])}</span></nav>
    <div class="pdp">
      <div class="pdp-gallery">{gallery(p)}</div>
      <div class="pdp-info">
        <p class="eyebrow">{eyebrow}</p>
        <h1 class="h-display pdp-title" id="page-title">{esc(p['name'])}</h1>
        {f'<p class="pdp-content">{esc(p["content"])}{" · " + esc(attrs["fragrance_family"]) if attrs.get("fragrance_family") else ""}</p>' if p.get('content') and not has_variants(p) else (f'<p class="pdp-content">{esc(attrs["fragrance_family"])}</p>' if attrs.get("fragrance_family") else '')}
        <div class="pdp-price" data-price-block>{price_html(p, big=True, v=dv)}</div>
        <p class="pdp-status is-{cls}" data-status><span class="dot" aria-hidden="true"></span>{stat_txt}</p>
        {f'<p class="pdp-short">{esc(p["short"])}</p>' if p.get('short') else ''}
        {notes_line(p)}
        {buy}
      </div>
    </div>
    <div class="pdp-more">{acc}</div>
  </div>
  {rel}
</main>"""
    return f"shop/{p['category']}/{p['slug']}/index.html", meta, body, "shop"


def sitemap_urls():
    if not visible():
        return []
    out = [("shop/", "0.8")] + [(f"shop/{c['slug']}/", "0.7") for c in LIVE_CATS] + [(url_of(p).lstrip("/"), "0.6") for p in PRODUCTS]
    return out


def catalog_js():
    return ("/* GEGENEREERD door src/build.py (src/shop.py) — niet met de hand aanpassen.\n"
            "   Momentopname van de catalogus; shop.js en product.js verversen prijzen en voorraad live uit Supabase. */\n"
            "window.ELUNEYA_CATALOG = " + json.dumps(CATALOG, ensure_ascii=False, separators=(",", ":")) + ";\n")


def build(write_page, domain, out, wa_link, cta_band, **_):
    """Schrijft alle shoppagina's en catalog.js. Zonder producten gebeurt er niets."""
    if not visible():
        return
    pages = [listing_page()] + [listing_page(c) for c in LIVE_CATS] + [product_page(p, wa_link) for p in PRODUCTS]
    for path, meta, body, active in pages:
        trail = meta.pop("_trail")
        ld = [breadcrumb_ld(domain, trail)] + [x.replace("{DOMAIN}", domain) for x in meta.pop("_extra_ld", [])]
        meta["_ld"] = ld
        if "og_image" in meta:
            meta["og_image"] = meta["og_image"].replace("{DOMAIN}", domain)
        body = body.replace("@@CTA@@", cta_band(title="Hulp nodig bij je keuze?", text="Twijfel je tussen twee geuren of zoek je een cadeau? Stuur Aida gerust een bericht.", btn_href="afspraak.html", btn="Maak afspraak"))
        write_page(meta, path, body, "/", active)
    # Generieke productpagina voor producten die nog geen vaste pagina hebben (Netlify-rewrite in netlify.toml)
    write_page({"title": "Product | Eluneya", "description": "Product van Eluneya.", "noindex": True, "styles": ["shop.css"],
                "extra_head": '\n  <script src="{BASE}assets/js/catalog.js" defer></script>\n  <script src="{BASE}assets/js/product.js" defer></script>'},
               "shop/product.html",
               '<main id="inhoud" class="shop product" data-product-dynamic><div class="container"><p class="lead" style="padding:48px 0">Even laden…</p></div></main>',
               "/", "shop")
    (out / "assets" / "js" / "catalog.js").write_text(catalog_js(), encoding="utf-8")
    print("gebouwd: assets/js/catalog.js")
