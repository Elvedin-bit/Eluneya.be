// Statische controle van de gebouwde website (site/): links, afbeeldingen, scripts, anchors, metadata, structured data, sitemap,
// plaatshouders en geheimen. Voert niets uit en verbindt met niets.
//   node test/site_check.mjs [map]      (standaard: site/)
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.argv[2] || join(repo, 'site'));
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const all = walk(root);
const pages = all.filter((f) => f.endsWith('.html'));
let fails = 0, warns = 0;
const bad = (m) => { console.log('  FOUT ' + m); fails++; };
const warn = (m) => { console.log('  let op ' + m); warns++; };
const ok = (m) => console.log('  ok   ' + m);

const attr = (tag, name) => (tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i')) || [])[1];
const urlPath = (p) => '/' + relative(root, p).replace(/\\/g, '/');
function resolveRef(ref, page) {
  let u = ref.split('#')[0].split('?')[0];
  if (!u) return page;
  const base = u.startsWith('/') ? join(root, u) : resolve(dirname(page), u);
  const cands = [base, base + '.html', join(base, 'index.html')];
  return cands.find((c) => existsSync(c) && statSync(c).isFile());
}
const idsOf = (file) => new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

console.log(`Controle van ${relative(repo, root) || '.'}: ${pages.length} pagina's, ${all.length} bestanden\n`);

console.log('Links, afbeeldingen, scripts en stijlen');
let refs = 0;
for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  const rel = urlPath(page);
  for (const m of html.matchAll(/<(a|link|script|img|source)\b[^>]*>/gi)) {
    const tag = m[0];
    const list = [];
    for (const n of ['href', 'src']) { const v = attr(tag, n); if (v) list.push(v); }
    const ss = attr(tag, 'srcset'); if (ss) ss.split(',').forEach((s) => list.push(s.trim().split(/\s+/)[0]));
    for (const ref of list) {
      if (/^(https?:|mailto:|tel:|data:|javascript:|\/\/)/i.test(ref) || ref.includes('{') ) continue;
      refs++;
      const target = resolveRef(ref, page);
      if (!target) { bad(`${rel}: verwijzing naar ontbrekend bestand "${ref}"`); continue; }
      const frag = ref.split('#')[1];
      if (frag && target.endsWith('.html') && !idsOf(target).has(frag)) bad(`${rel}: anchor "#${frag}" bestaat niet in ${urlPath(target)}`);
    }
    // externe links die in een nieuw venster openen: rel="noopener"
    if (/^<a\b/i.test(tag) && /target="_blank"/i.test(tag) && !/rel="[^"]*noopener/i.test(tag)) bad(`${rel}: target=_blank zonder rel=noopener (${(attr(tag, 'href') || '').slice(0, 50)})`);
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    if (attr(m[0], 'alt') === undefined) bad(`${rel}: <img> zonder alt (${(attr(m[0], 'src') || '').slice(0, 40)})`);
    if ((!attr(m[0], 'width') || !attr(m[0], 'height')) && !rel.endsWith('/admin.html')) warn(`${rel}: <img> zonder width/height (layoutsprong)`);
  }
}
ok(`${refs} interne verwijzingen gecontroleerd`);

console.log('\nMetadata en structured data');
const titles = new Map();
for (const page of pages) {
  const html = readFileSync(page, 'utf8'), rel = urlPath(page);
  const title = (html.match(/<title>(.*?)<\/title>/s) || [])[1], desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1];
  const canon = (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1], noindex = /name="robots" content="[^"]*noindex/.test(html);
  if (!title) bad(`${rel}: geen <title>`);
  else { if (title.length > 70) warn(`${rel}: title is ${title.length} tekens (>70)`); (titles.get(title) || titles.set(title, []).get(title)).push(rel); }
  if (!desc && !(noindex && rel.endsWith('/admin.html'))) bad(`${rel}: geen meta description`); else if (desc && desc.length > 170) warn(`${rel}: description is ${desc.length} tekens`);
  if (!canon && !rel.endsWith('/admin.html')) bad(`${rel}: geen canonical`);
  if (!/<html[^>]*\slang="/.test(html)) bad(`${rel}: geen lang-attribuut`);
  if (!/name="viewport"/.test(html)) bad(`${rel}: geen viewport`);
  if ((html.match(/<h1\b/g) || []).length !== 1 && !rel.endsWith('/admin.html')) warn(`${rel}: ${(html.match(/<h1\b/g) || []).length} h1-koppen`);
  if (!noindex && !/property="og:title"/.test(html) && !rel.endsWith('/admin.html')) bad(`${rel}: geen Open Graph`);
  for (const m of html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)) {
    try { const j = JSON.parse(m[1]); if (!j['@context'] || !(j['@type'] || j['@graph'])) bad(`${rel}: JSON-LD mist @context/@type`); }
    catch (e) { bad(`${rel}: ongeldige JSON-LD (${e.message})`); }
  }
}
for (const [t, p] of titles) if (p.length > 1 && !p.every((x) => /404|admin/.test(x))) warn(`dubbele title "${t.slice(0, 50)}": ${p.join(', ')}`);
ok(`metadata van ${pages.length} pagina's bekeken`);

console.log('\nSitemap en robots.txt');
if (existsSync(join(root, 'sitemap.xml'))) {
  const sm = readFileSync(join(root, 'sitemap.xml'), 'utf8');
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const l of locs) { const p = new URL(l).pathname; if (!resolveRef(p, join(root, 'index.html'))) bad(`sitemap: ${l} bestaat niet als pagina`); }
  const domains = new Set(locs.map((l) => new URL(l).origin));
  ok(`${locs.length} URL's in de sitemap, allemaal aanwezig; domein: ${[...domains].join(', ')}`);
  for (const p of pages) { const h = readFileSync(p, 'utf8'); if (/name="robots" content="[^"]*noindex/.test(h) && locs.some((l) => new URL(l).pathname === urlPath(p).replace(/index\.html$/, '').replace(/\.html$/, '') || new URL(l).pathname === urlPath(p))) bad(`${urlPath(p)}: staat in de sitemap maar is noindex`); }
} else bad('sitemap.xml ontbreekt');
if (!existsSync(join(root, 'robots.txt'))) bad('robots.txt ontbreekt'); else ok('robots.txt aanwezig');

console.log('\nGeheimen en gevoelige gegevens in de uitgeleverde bestanden');
const text = all.filter((f) => /\.(html|js|css|json|txt|xml|webmanifest)$/.test(f));
for (const f of text) {
  const t = readFileSync(f, 'utf8');
  if (/service_role|sb_secret_|-----BEGIN [A-Z ]*PRIVATE KEY|SUPABASE_SERVICE/i.test(t.replace(/Gebruik hier NOOIT de secret\/service_role key\./, '').replace(/geen service_role|service_role-sleutel/gi, ''))) {
    const hit = (t.match(/.{0,40}(service_role|sb_secret_|PRIVATE KEY).{0,40}/i) || [''])[0].trim();
    bad(`${urlPath(f)}: mogelijk geheim: "${hit}"`);
  }
  for (const m of t.matchAll(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g)) {
    try { const p = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString()); if (p.role && p.role !== 'anon') bad(`${urlPath(f)}: JWT met rol "${p.role}"`); } catch { /* geen jwt */ }
  }
}
const cfg = readFileSync(join(root, 'assets/js/config.js'), 'utf8');
const key = (cfg.match(/supabaseKey:\s*'([^']*)'/) || [])[1] || '';
if (/^sb_publishable_/.test(key)) ok('config.js bevat enkel een publishable key (bedoeld publiek)'); else if (/^eyJ/.test(key)) warn('config.js bevat een JWT-sleutel: controleer dat het de anon-sleutel is'); else bad(`config.js: onverwachte sleutel (${key.slice(0, 12)}…)`);
if (existsSync(join(root, 'assets/js/catalog.js'))) ok('catalog.js aanwezig (shop zichtbaar)'); else ok('geen catalog.js: shop onzichtbaar (geen producten)');

console.log('\nPlaatshouders voor ontbrekende gegevens (door Aida in te vullen)');
const ph = new Map();
for (const p of pages) for (const m of readFileSync(p, 'utf8').matchAll(/\[IN TE VULLEN[^\]]*\]/g)) { const k = m[0].slice(0, 70); ph.set(k, (ph.get(k) || 0) + 1); }
if (ph.size) { for (const [k, n] of ph) warn(`${n}× ${k}`); } else ok('geen plaatshouders');

console.log(fails ? `\n${fails} fout(en), ${warns} aandachtspunt(en)` : `\nGeen fouten, ${warns} aandachtspunt(en)`);
process.exit(fails ? 1 : 0);
