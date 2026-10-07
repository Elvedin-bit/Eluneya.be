#!/usr/bin/env python3
"""Maakt één zelfstandig voorbeeldbestand van de website: alle pagina's (ook de shop en de winkelmand), CSS, JS, lettertypen en foto's
zijn ingebakken. Dubbelklik op het bestand (of stuur het door); het werkt zonder internet en zonder server.

In het voorbeeld wordt NIETS naar de echte database gestuurd: de agenda toont een lege (volledig vrije) week, boeken en bestellen
worden geweigerd, en een klein label linksonder zegt dat het een voorbeeld is.

Gebruik (vanuit de projectmap):
    python3 src/preview.py                                  # de gebouwde site in site/
    python3 src/preview.py --site <map> --out <bestand>     # een andere gebouwde site, bv. met demo-producten
    python3 src/preview.py --label "Voorbeeld · demo-producten"

Demo-producten bouwen:  ELUNEYA_OUT=<map> ELUNEYA_CATALOG=src/catalog.demo.json python3 src/build.py
"""
import argparse
import base64
import html as htmllib
import json
import pathlib
import re

ap = argparse.ArgumentParser()
ap.add_argument("--site", default="site")
ap.add_argument("--out", default="voorbeeld/eluneya-voorbeeld.html")
ap.add_argument("--label", default="Voorbeeldversie · niet de live website")
args = ap.parse_args()
S = pathlib.Path(args.site)
OUT = pathlib.Path(args.out)


def b64(path, mime):
    return f"data:{mime};base64," + base64.b64encode((S / path).read_bytes()).decode()


def route_of(rel):
    """index.html → index · over.html → over · shop/index.html → shop · shop/a/b/index.html → shop/a/b"""
    r = re.sub(r"index\.html$", "", rel).replace("\\", "/")
    r = re.sub(r"\.html$", "", r).strip("/")
    return r or "index"


def to_route(href):
    """Interne verwijzing → '#/route?query' (of None als het geen interne pagina is)."""
    m = re.match(r"^/?((?:[a-z0-9-]+\.html)|(?:shop(?:/[^\"?#]*)?)|(?:))(\?[^\"#]*)?(#[^\"]*)?$", href)
    if not m or (m.group(1) == "" and not (m.group(2) or m.group(3)) and href not in ("/", "")):
        return None
    if m.group(3) and not m.group(1) and not m.group(2):
        return None
    return "#/" + route_of(m.group(1) or "index.html") + (m.group(2) or "")


# ---------------------------------------------------------------- pagina's verzamelen
files = [p for p in S.rglob("*.html") if p.name not in ("404.html", "admin.html") and "admin" not in p.parts]
order = ["index", "behandelingen", "journeys", "over", "contact", "afspraak", "privacy", "voorwaarden", "winkelmand"]
pages_src = {route_of(str(p.relative_to(S))): p for p in files}
routes = [r for r in order if r in pages_src] + sorted(r for r in pages_src if r not in order)

first = (S / "index.html").read_text(encoding="utf-8")
header = re.search(r'<a class="skip-link".*?</header>', first, re.S).group(0)
footer = re.search(r'<footer class="site-footer">.*?</footer>', first, re.S).group(0)
js_names = set()
IMG_RE = re.compile(r'\s(?:srcset|sizes)="[^"]*"')


def prep(html):
    html = IMG_RE.sub("", html)
    html = re.sub(r'src="/?assets/img/([^"?]+?)(?:\.webp)?"', lambda m: f'data-pvimg="{m.group(1)}"', html)
    js_names.update(re.findall(r'data-pvimg="([^"]+)"', html))
    html = re.sub(r'href="([^"]*)"', lambda m: f'href="{to_route(m.group(1)) or m.group(1)}"', html)
    return html


PAGES = {}
for r in routes:
    raw = pages_src[r].read_text(encoding="utf-8")
    main = re.search(r"<main\b[^>]*>.*?</main>", raw, re.S).group(0)
    title = htmllib.unescape(re.search(r"<title>(.*?)</title>", raw, re.S).group(1))
    PAGES[r] = {"html": prep(main), "title": title, "hero": 'class="has-hero"' in raw.split("<body", 1)[1][:80]}
header, footer = prep(header), prep(footer)

# afbeeldingen die enkel via JavaScript (catalogus) voorkomen
catalog_js = (S / "assets/js/catalog.js").read_text(encoding="utf-8") if (S / "assets/js/catalog.js").exists() else ""
js_names.update(re.findall(r"assets/img/([a-z0-9-]+)\.webp", catalog_js))
IMG = {n: b64(f"assets/img/{n}.webp", "image/webp") for n in sorted(js_names) if (S / f"assets/img/{n}.webp").exists()}

# ---------------------------------------------------------------- CSS (lettertypen ingebakken)
css = "\n".join((S / f"assets/css/{f}").read_text(encoding="utf-8") for f in ("style.css", "shop.css") if (S / f"assets/css/{f}").exists())
css = re.sub(r'url\("\.\./fonts/([^"]+)"\)', lambda m: f'url("{b64("assets/fonts/" + m.group(1), "font/woff2")}")', css)

# ---------------------------------------------------------------- JavaScript
rd = lambda f: (S / "assets/js" / f).read_text(encoding="utf-8") if (S / "assets/js" / f).exists() else ""
safe = lambda s: s.replace("</", "<\\/")
page_scripts = {k: rd(f) for k, f in {"shop": "shop.js", "product": "product.js", "checkout": "checkout.js", "booking": "booking.js"}.items()}

stub = """
(function(){ // alles naar 'voorbeeld.invalid' wordt hier beantwoord; er gaat niets het internet op
  var real = window.fetch;
  window.fetch = function (u, o) {
    u = String(u);
    if (u.indexOf('https://voorbeeld.invalid/') !== 0) { return real.apply(this, arguments); }
    var fn = (u.match(/\\/rpc\\/([a-z_]+)/) || [])[1];
    function j(x, s) { return Promise.resolve(new Response(JSON.stringify(x), { status: s || 200, headers: { 'Content-Type': 'application/json' } })); }
    if (fn === 'get_booked_slots') { return j([]); }
    if (fn === 'get_price_quote') {
      var b = JSON.parse(o.body), s = ((window.ELUNEYA_DATA || {}).services || []).filter(function (x) { return x.slug === b.p_service; })[0], p = s ? s.price : 0;
      return j({ list_price: p, discount: 0, price: p, promotion: null, code_status: 'none' });
    }
    if (fn) { return j({ message: 'voorbeeld_versie' }, 400); }
    return j({ message: 'niet beschikbaar in het voorbeeld' }, 404);
  };
})();
"""

router = r"""
(function () {
  var PAGES = __PAGES__, IMG = __IMG__, SRC = __SRC__;
  var root = document.getElementById('pv-root'), current = null;
  history.replaceState = function () {};            // shop.js schrijft filters in de URL; in het voorbeeld niet
  function fixImgs(scope) {
    (scope || document).querySelectorAll('img[data-pvimg], img[src^="/assets/img/"]').forEach(function (img) {
      var n = (img.getAttribute('data-pvimg') || img.getAttribute('src').replace(/^\/?assets\/img\//, '')).split('?')[0].replace(/\.webp$/, '');
      if (IMG[n]) { img.removeAttribute('data-pvimg'); img.src = IMG[n]; }
    });
  }
  new MutationObserver(function (muts) {
    muts.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) { fixImgs(n.tagName === 'IMG' ? n.parentNode : n); } }); });
  }).observe(document.body, { childList: true, subtree: true });

  function toRoute(h) {
    var u = h.replace(/^\//, ''), q = '', i = u.indexOf('?');
    if (i >= 0) { q = u.slice(i); u = u.slice(0, i); }
    u = u.replace(/#.*$/, '').replace(/index\.html$/, '').replace(/\.html$/, '').replace(/\/$/, '');
    return (u || 'index') + q;
  }
  document.addEventListener('click', function (e) {   // verwijzingen die JavaScript maakt ('/shop/…', '/winkelmand.html')
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) { return; }
    var h = a.getAttribute('href');
    if (/^\/(?!\/)/.test(h)) { e.preventDefault(); location.hash = '#/' + toRoute(h); }
  }, true);

  function markNav(route) {
    var key = route.indexOf('shop') === 0 ? 'shop' : route;
    document.querySelectorAll('.nav-links a, .mobile-menu a:not(.btn)').forEach(function (a) {
      var on = a.getAttribute('href') === '#/' + key || (key === 'index' && a.getAttribute('href') === '#/index');
      if (on && !a.closest('.subnav') && !a.closest('.menu-sub')) { a.setAttribute('aria-current', 'page'); } else { a.removeAttribute('aria-current'); }
    });
  }
  function run(name) { try { (0, eval)(SRC[name]); } catch (err) { console.error('voorbeeld:', name, err); } }

  function show() {
    var h = decodeURIComponent(location.hash.slice(1)), route = null, q = '', anchor = null;
    if (h.charAt(0) === '/') { var p = h.slice(1).split('?'); route = p[0] || 'index'; q = p[1] || ''; }
    else if (h) {
      var t = document.getElementById(h);
      if (t) { t.scrollIntoView(); return; }
      for (var k in PAGES) { if (PAGES[k].html.indexOf('id="' + h + '"') >= 0) { route = k; anchor = h; break; } }
    }
    if (!route) { route = current || 'index'; }
    if (!PAGES[route]) { route = 'index'; }
    var menu = document.querySelector('.nav-toggle[aria-expanded="true"]'); if (menu) { menu.click(); }
    root.innerHTML = PAGES[route].html; current = route;
    document.title = PAGES[route].title + ' (voorbeeld)';
    document.body.classList.toggle('has-hero', PAGES[route].hero);
    root.querySelectorAll('.reveal').forEach(function (e) { e.classList.add('is-visible'); });
    fixImgs(root); markNav(route);
    var html = PAGES[route].html;
    if (html.indexOf('data-shop-mode') >= 0) { run('shop'); }
    if (html.indexOf('data-product-id') >= 0) { run('product'); }
    if (route === 'winkelmand') { run('checkout'); }
    if (route === 'afspraak') {
      run('booking');
      var m = q.match(/behandeling=([^&]+)/), s = document.getElementById('service');
      if (m && s && s.querySelector('option[value="' + m[1] + '"]')) { s.value = m[1]; s.dispatchEvent(new Event('change')); }
    }
    var target = anchor && document.getElementById(anchor);
    if (target) { target.scrollIntoView(); } else { window.scrollTo(0, 0); }
  }
  window.addEventListener('hashchange', show); show();
})();
"""

router = (router.replace("__PAGES__", safe(json.dumps({k: {"html": v["html"], "title": v["title"], "hero": v["hero"]} for k, v in PAGES.items()}, ensure_ascii=False)))
                .replace("__IMG__", json.dumps(IMG)).replace("__SRC__", safe(json.dumps(page_scripts))))

shell_js = "\n".join(safe(rd(f)) for f in ("services.js",)) + "\n" + safe(catalog_js)
html = f"""<!doctype html>
<html lang="nl-BE"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eluneya — voorbeeld van de website</title><meta name="robots" content="noindex">
<link rel="icon" href="{b64('favicon.svg', 'image/svg+xml')}">
<style>{css}
.pv-badge{{position:fixed;left:12px;bottom:12px;z-index:4000;max-width:calc(100vw - 24px);padding:8px 14px;border-radius:999px;background:rgba(41,36,32,.92);color:#fff;font:400 12px/1.4 Poppins,system-ui,sans-serif;display:flex;gap:10px;align-items:center}}
.pv-badge button{{color:#fff;opacity:.7;font-size:16px;line-height:1}}
</style>
<script>document.documentElement.classList.add('js');window.ELUNEYA_CONFIG={{supabaseUrl:'https://voorbeeld.invalid',supabaseKey:'voorbeeld'}};</script>
</head><body class="has-hero">
{header}
<div id="pv-root"></div>
{footer}
<div class="pv-badge" id="pv-badge" role="note"><span>{args.label} · boeken en bestellen werkt hier niet</span><button type="button" aria-label="Sluiten" onclick="this.parentNode.remove()">✕</button></div>
<script>{stub}</script>
<script>{shell_js}</script>
<script>{safe(rd('cart.js'))}</script>
<script>{safe(rd('main.js'))}</script>
<script>{router}</script>
</body></html>
"""
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(html, encoding="utf-8")
print(f"{OUT}: {len(html) // 1024} KB, {len(PAGES)} pagina's, {len(IMG)} foto's")
