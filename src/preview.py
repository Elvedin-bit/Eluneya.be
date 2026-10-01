"""Maakt één zelfstandig voorbeeldbestand (alle pagina's, CSS, JS, fonts en foto's ingebakken)."""
import re, base64, pathlib
S = pathlib.Path("site")
def b64(p, mime): return f"data:{mime};base64," + base64.b64encode((S / p).read_bytes()).decode()
PAGES = ["index", "behandelingen", "journeys", "over", "contact", "afspraak", "privacy", "voorwaarden"]

css = (S / "assets/css/style.css").read_text()
css = re.sub(r'url\("\.\./fonts/([^"]+)"\)', lambda m: f'url("{b64("assets/fonts/" + m.group(1), "font/woff2")}")', css)

def imgs(html):
    # srcset weg, enkel de grote variant ingebakken
    html = re.sub(r'\s(srcset|sizes)="[^"]*"', "", html)
    return re.sub(r'src="assets/img/([^"]+)"', lambda m: f'src="{b64("assets/img/" + m.group(1), "image/webp")}"', html)

def links(html):
    def rep(m):
        page, query, frag = m.group(1), m.group(2) or "", m.group(3) or ""
        if frag: return f'href="#{frag[1:]}"'
        return f'href="#/{page}{query}"'
    return re.sub(r'href="(index|behandelingen|journeys|over|contact|afspraak|privacy|voorwaarden)\.html(\?[^"#]*)?(#[^"]*)?"', rep, html)

first = (S / "index.html").read_text()
header = re.search(r'<a class="skip-link".*?</header>', first, re.S).group(0)
footer = re.search(r'<footer class="site-footer">.*?</footer>', first, re.S).group(0)
mains = []
for p in PAGES:
    h = (S / f"{p}.html").read_text()
    main = re.search(r'<main id="inhoud">(.*?)</main>', h, re.S).group(1)
    hero = ' data-hero="1"' if p == "index" else ""
    mains.append(f'<main class="pv-page" id="pv-{p}" data-page="{p}"{hero}>{main}</main>')
body = links(imgs(header + "\n" + "\n".join(mains) + "\n" + footer))
body = body.replace('aria-current="page"', "")
js = "\n".join((S / f"assets/js/{f}").read_text() for f in ["config.js", "services.js"])
router = r"""
(function(){
  var pages=[].slice.call(document.querySelectorAll('.pv-page'));
  function show(){
    var h=decodeURIComponent(location.hash.slice(1)), name='index', q='', target=null;
    if(h.charAt(0)==='/'){ var parts=h.slice(1).split('?'); name=parts[0]||'index'; q=parts[1]||''; }
    else if(h){ target=document.getElementById(h); var pg=target&&target.closest('.pv-page'); if(pg){name=pg.dataset.page;} }
    pages.forEach(function(p){ p.hidden = p.dataset.page!==name; });
    var cur=document.getElementById('pv-'+name)||pages[0];
    document.body.classList.toggle('has-hero', !!cur.dataset.hero);
    document.querySelectorAll('.nav-links a, .mobile-menu a').forEach(function(a){
      a.toggleAttribute('aria-current', a.getAttribute('href')==='#/'+name); if(a.hasAttribute('aria-current')) a.setAttribute('aria-current','page'); });
    window.__pvQuery=q;
    if(target){ target.scrollIntoView(); } else { window.scrollTo(0,0); }
    cur.querySelectorAll('.reveal').forEach(function(e){ e.classList.add('is-visible'); });
    if(name==='afspraak' && q){ var m=q.match(/behandeling=([^&]+)/), s=document.getElementById('service');
      if(m&&s&&s.querySelector('option[value="'+m[1]+'"]')){ s.value=m[1]; s.dispatchEvent(new Event('change')); } }
  }
  window.addEventListener('hashchange', show); show();
})();
"""
html = f"""<!doctype html>
<html lang="nl-BE"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eluneya — voorbeeld van de website</title><meta name="robots" content="noindex">
<link rel="icon" href="{b64('favicon.svg','image/svg+xml')}">
<style>{css}
.pv-page[hidden]{{display:none!important}}</style>
<script>document.documentElement.classList.add('js');</script>
</head><body class="has-hero">
{body}
<script>{js}</script>
<script>{(S / 'assets/js/main.js').read_text()}</script>
<script>{router}</script>
<script>{(S / 'assets/js/booking.js').read_text()}</script>
</body></html>"""
pathlib.Path("/home/claude/out/eluneya-voorbeeld.html").write_text(html, encoding="utf-8")
print(len(html) // 1024, "KB")
