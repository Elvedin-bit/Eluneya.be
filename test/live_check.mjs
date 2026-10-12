// Controle van een gepubliceerde site: elk bestand uit site/ moet live bestaan en byte-voor-byte gelijk zijn; verder statuscodes, headers,
// de 404-pagina en de bereikbaarheid van de belangrijkste pagina's. Alleen lezen (GET).
//   node test/live_check.mjs https://eluneya-be.netlify.app
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!base) { console.error('Gebruik: node test/live_check.mjs <https://…>'); process.exit(2); }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../site');
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const sha = (b) => createHash('sha256').update(b).digest('hex');
let fails = 0;
const check = (name, cond, info = '') => { console.log((cond ? '  ok   ' : '  FOUT ') + name + (!cond && info ? `  [${info}]` : '')); if (!cond) fails++; };

console.log(`Live controle van ${base}\n\nBestanden: live gelijk aan lokale site/`);
let same = 0, total = 0;
for (const f of walk(root)) {
  const rel = relative(root, f).replace(/\\/g, '/');
  total++;
  const r = await fetch(`${base}/${rel}`, { headers: { 'Cache-Control': 'no-cache' } });
  const buf = Buffer.from(await r.arrayBuffer());
  if (r.status !== 200) { check(`/${rel} → ${r.status}`, false); continue; }
  const isText = /\.(html|css|js|txt|xml|webmanifest|json|svg)$/.test(rel);
  const norm = (x) => (isText ? Buffer.from(x.toString('utf8').split('\r\n').join('\n')) : x);   // Windows (CRLF) en Git/Netlify (LF) zijn inhoudelijk gelijk
  if (rel.endsWith('.html')) {
    // Netlify "pretty URLs" herschrijft links (/over.html → /over) en voegt een commentaar toe: vergelijk dus inhoud, metadata en JSON-LD
    const sig = (x) => {
      const t = x.toString('utf8');
      const ld = [...t.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.stringify(JSON.parse(m[1]))).join('|');
      const meta = [(t.match(/<title>([\s\S]*?)<\/title>/) || [])[1], (t.match(/name=["']description["'] content=["']([^"']*)/) || [])[1]].join('|');
      const text = t.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return sha(Buffer.from(ld + '##' + meta + '##' + text));
    };
    if (sig(buf) !== sig(readFileSync(f))) { check(`/${rel}: inhoud/metadata/JSON-LD wijkt af van het lokale bestand`, false, `${buf.length} vs ${readFileSync(f).length} bytes`); continue; }
  } else if (sha(norm(buf)) !== sha(norm(readFileSync(f)))) { check(`/${rel} wijkt af van het lokale bestand`, false, `${buf.length} vs ${readFileSync(f).length} bytes`); continue; }
  same++;
}
check(`${same}/${total} bestanden live en identiek`, same === total);

console.log('\nRoutes en statuscodes');
for (const [p, code] of [['/', 200], ['/afspraak.html', 200], ['/behandelingen.html', 200], ['/admin.html', 200], ['/sitemap.xml', 200], ['/robots.txt', 200], ['/bestaat-niet-xyz', 404], ['/shop/', 404]]) {
  const r = await fetch(base + p, { redirect: 'manual' }); check(`${p} → ${r.status} (verwacht ${code})`, r.status === code, r.status);
}
const nf = await fetch(base + '/bestaat-niet-xyz'); const nfText = await nf.text();
check('404-pagina is de eigen pagina van de site', /Pagina niet gevonden/.test(nfText));

console.log('\nHeaders');
const h = (await fetch(base + '/')).headers;
check('X-Content-Type-Options: nosniff', h.get('x-content-type-options') === 'nosniff', h.get('x-content-type-options'));
check('X-Frame-Options: SAMEORIGIN', (h.get('x-frame-options') || '').toUpperCase() === 'SAMEORIGIN', h.get('x-frame-options'));
check('Referrer-Policy aanwezig', !!h.get('referrer-policy'));
check('Permissions-Policy aanwezig', !!h.get('permissions-policy'));
const ha = (await fetch(base + '/admin.html')).headers;
check('admin.html: noindex en no-store', /noindex/.test(ha.get('x-robots-tag') || '') && /no-store/.test(ha.get('cache-control') || ''), `${ha.get('x-robots-tag')} | ${ha.get('cache-control')}`);
const hf = (await fetch(base + '/assets/fonts/poppins-latin-400-normal.woff2')).headers;
check('lettertypen: lange cache (immutable)', /immutable/.test(hf.get('cache-control') || ''), hf.get('cache-control'));
check('HTTPS actief', base.startsWith('https://'));

console.log('\nShop');
const idx = await (await fetch(base + '/')).text();
check('Shop is (nog) onzichtbaar in het menu: geen producten', !/href="\/?shop\//.test(idx) && !/cart-link/.test(idx));
check('geen catalog.js live', (await fetch(base + '/assets/js/catalog.js')).status === 404);

console.log(fails ? `\n${fails} controle(s) MISLUKT` : '\nLive controle geslaagd');
process.exit(fails ? 1 : 0);
