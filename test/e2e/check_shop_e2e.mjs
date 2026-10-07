// Integratietest van de webshop over HTTP: product → variant → bestelling → voorraad → admin → annulering,
// plus controle dat een anonieme bezoeker nooit orders, ordergegevens, voorraad of adminfuncties bereikt en geen prijs kan sturen.
//
// Draait tegen een TESTOMGEVING, nooit tegen productie:
//   * lokaal (standaard): de stack uit stack.mjs (echte PostgreSQL + echte PostgREST) — leest test/e2e/.data/env.json
//   * een aparte test-Supabase: zet E2E_REST_URL (…/rest/v1), E2E_ANON_KEY, E2E_ADMIN_JWT en E2E_USER_JWT (of E2E_ADMIN_EMAIL +
//     E2E_ADMIN_PASSWORD + E2E_AUTH_URL), én E2E_TEST_PROJECT_REF=<ref van het testproject>.
// Beveiligingen: het script weigert het productieproject (ref jdfcheqimbxffxldedey of de URL uit site/assets/js/config.js) en elk
// extern adres zonder E2E_TEST_PROJECT_REF. Alle testgegevens beginnen met "e2e-" en worden achteraf opgeruimd.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const PROD_REF = 'jdfcheqimbxffxldedey';

// ---------------------------------------------------------------- configuratie + veiligheid
let cfg = {};
const envFile = resolve(here, '.data/env.json');
if (!process.env.E2E_REST_URL && existsSync(envFile)) {
  const e = JSON.parse(readFileSync(envFile, 'utf8'));
  cfg = { rest: e.restUrl, anon: e.anonKey, admin: e.adminJwt, user: e.userJwt, local: true };
} else if (process.env.E2E_REST_URL) {
  cfg = { rest: process.env.E2E_REST_URL.replace(/\/+$/, ''), anon: process.env.E2E_ANON_KEY, admin: process.env.E2E_ADMIN_JWT, user: process.env.E2E_USER_JWT, local: false };
} else {
  console.error('Geen testomgeving gevonden. Start eerst "node stack.mjs" of zet E2E_REST_URL (zie bovenaan dit bestand).'); process.exit(2);
}
const prodUrl = (readFileSync(resolve(repo, 'site/assets/js/config.js'), 'utf8').match(/supabaseUrl:\s*'([^']+)'/) || [])[1] || '';
const host = new URL(cfg.rest).hostname;
const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(host);
if (cfg.rest.includes(PROD_REF) || (prodUrl && new URL(prodUrl).hostname === host)) { console.error('GEWEIGERD: dit is het productieproject.'); process.exit(3); }
if (!isLocal && (!process.env.E2E_TEST_PROJECT_REF || !host.startsWith(process.env.E2E_TEST_PROJECT_REF + '.') || process.env.E2E_TEST_PROJECT_REF === PROD_REF)) {
  console.error('GEWEIGERD: extern adres zonder geldige E2E_TEST_PROJECT_REF (de ref van het TESTproject, niet van productie).'); process.exit(3);
}
if (!cfg.local && process.env.E2E_ADMIN_EMAIL && !cfg.admin) {
  const r = await fetch(`${process.env.E2E_AUTH_URL}/token?grant_type=password`, { method: 'POST', headers: { apikey: cfg.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD }) });
  cfg.admin = (await r.json()).access_token;
}
if (!cfg.anon || !cfg.admin || !cfg.user) { console.error('Sleutels ontbreken (anon, admin en gewone gebruiker).'); process.exit(2); }
console.log(`Testomgeving: ${cfg.rest}${isLocal ? ' (lokaal)' : ''}\n`);

// ---------------------------------------------------------------- hulp
let fails = 0;
const check = (name, cond, info = '') => { console.log((cond ? '  ok   ' : '  FOUT ') + name + (!cond && info ? `  [${String(info).slice(0, 260)}]` : '')); if (!cond) fails++; };
async function call(who, method, path, body, extra = {}) {
  const jwt = who === 'admin' ? cfg.admin : who === 'user' ? cfg.user : null;
  const headers = { apikey: cfg.anon, 'Content-Type': 'application/json', Accept: 'application/json', ...extra };
  if (jwt) headers.Authorization = `Bearer ${jwt}`; else if (/^eyJ/.test(cfg.anon)) headers.Authorization = `Bearer ${cfg.anon}`;
  const r = await fetch(`${cfg.rest}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* geen json */ }
  return { status: r.status, json, text, ok: r.ok };
}
const denied = (r) => [401, 403].includes(r.status) && (r.json?.code === '42501' || /permission denied|row-level security/i.test(r.text));
const rows = (r) => (Array.isArray(r.json) ? r.json : []);
const rpc = (who, fn, args) => call(who, 'POST', `rpc/${fn}`, args ?? {});
const REP = { Prefer: 'return=representation' };
const msg = (r) => String(r.json?.message || r.text);

// Dezelfde select als de website (cart.js), zodat de echte frontend-query getest wordt.
const cartJs = readFileSync(resolve(repo, 'site/assets/js/cart.js'), 'utf8');
const SELECT = new Function('return ' + cartJs.match(/var SELECT = ([\s\S]*?);\n  function normalise/)[1])();

const tag = Date.now().toString(36);
const slug = `e2e-parfum-${tag}`;
const order = (items, o = {}) => rpc('anon', 'place_order', { p_items: items, p_name: 'E2E Klant', p_email: o.email || `e2e+${tag}@example.test`, p_phone: null, p_delivery: 'afhalen',
  p_street: null, p_postal: null, p_city: null, p_notes: null, p_consent: true, p_expected_total: o.expected ?? null, ...(o.extra || {}) });

// ---------------------------------------------------------------- 1. product + varianten (admin)
console.log('1. Admin maakt een parfum met varianten aan');
const cat = rows(await call('admin', 'GET', 'product_categories?slug=eq.parfums&select=id'))[0];
check('categorie parfums bestaat', !!cat);
const brand = await call('admin', 'POST', 'brands', { slug: `e2e-merk-${tag}`, name: 'E2E Merk' }, REP);
check('admin maakt merk', brand.status === 201, brand.text);
const prod = await call('admin', 'POST', 'products', { slug, name: 'E2E Parfum', category_id: cat.id, brand_id: brand.json[0].id, price_eur: 80, short_description: 'Testparfum',
  description: 'Alleen voor tests', is_active: true, is_featured: false, sku: `E2E-${tag}`, track_stock: true, stock_qty: 7 }, REP);
check('admin maakt product', prod.status === 201, prod.text);
const P = prod.json[0].id;
const vr = await call('admin', 'POST', 'product_variants', [
  { product_id: P, label: '15 ml', volume_ml: 15, sku: `E2E-${tag}-15`, price_eur: 29, stock_qty: 5, sort_order: 0, is_active: true },
  { product_id: P, label: '30 ml', volume_ml: 30, sku: `E2E-${tag}-30`, price_eur: 49, stock_qty: 2, sort_order: 1, is_active: true },
  { product_id: P, label: '50 ml', volume_ml: 50, sku: `E2E-${tag}-50`, price_eur: 69, stock_qty: 9, sort_order: 2, is_active: false },
  { product_id: P, label: '70 ml', volume_ml: 70, sku: `E2E-${tag}-70`, price_eur: 89, stock_qty: null, sort_order: 3, is_active: true },
], REP);
check('admin maakt 4 varianten (waarvan 1 uitgeschakeld)', vr.status === 201 && vr.json.length === 4, vr.text);
const V = Object.fromEntries(vr.json.map((v) => [v.label, v.id]));
check('admin maakt attributen (geurprofiel)', (await call('admin', 'POST', 'product_attributes', { product_id: P, data: { fragrance_family: 'Fris', notes: { top: ['citroen'], heart: ['neroli'], base: ['musk'] } } })).status === 201);
check('admin maakt productafbeelding', (await call('admin', 'POST', 'product_images', { product_id: P, url: '/assets/img/geurbeleving-lg.webp', alt: 'E2E', is_primary: true })).status === 201);
const adminStock = async (label) => rows(await call('admin', 'GET', `product_variants?id=eq.${V[label]}&select=stock_qty`))[0]?.stock_qty;

// ---------------------------------------------------------------- 2. publiek (anon) leest de catalogus
console.log('\n2. Bezoeker (anon) leest product en varianten via de echte frontend-query');
const pub = await call('anon', 'GET', `products?select=${SELECT}&slug=eq.${slug}`);
check('frontend-query (met embeds) werkt voor anon', pub.status === 200 && rows(pub).length === 1, pub.text);
const pp = rows(pub)[0] || {};
check('categorie, merk, attributen en afbeelding zijn meegekomen', pp.product_categories?.slug === 'parfums' && pp.brands?.name === 'E2E Merk' && !!pp.product_attributes && pp.product_images?.length === 1);
check('enkel de 3 actieve varianten zijn zichtbaar (50 ml niet)', (pp.product_variants || []).map((v) => v.label).sort().join('|') === '15 ml|30 ml|70 ml', JSON.stringify(pp.product_variants));
check('variant toont volume_ml, SKU en is_available', pp.product_variants?.every((v) => v.volume_ml != null && v.sku && v.is_available === true));
check('geen stock_qty of track_stock in het publieke antwoord', !/stock_qty|track_stock/.test(pub.text));
check('productfilter op slug van inactief product geeft niets', rows(await call('anon', 'GET', `products?select=id&slug=eq.nope-${tag}`)).length === 0);

// ---------------------------------------------------------------- 3. anon kan niets lezen wat privé is
console.log('\n3. Bezoeker kan geen orders, ordergegevens, voorraad of beheer bereiken');
for (const t of ['orders', 'order_items', 'admins']) { const r = await call('anon', 'GET', `${t}?select=*`); check(`anon kan ${t} niet lezen`, denied(r), `${r.status} ${r.text}`); }
for (const col of ['stock_qty', 'track_stock']) { const r = await call('anon', 'GET', `products?select=${col}`); check(`anon kan products.${col} niet lezen`, denied(r), `${r.status} ${r.text}`); }
{ const r = await call('anon', 'GET', 'products?select=*'); check('anon: select=* op products geweigerd', denied(r), r.text); }
{ const r = await call('anon', 'GET', 'product_variants?select=stock_qty'); check('anon kan variantvoorraad niet lezen', denied(r), r.text); }
{ const r = await call('anon', 'GET', `orders?select=customer_email,customer_name,customer_phone,total_eur`); check('anon kan klantgegevens (e-mail, naam, telefoon) niet lezen', denied(r), r.text); }
for (const [t, body] of [['products', { slug: 'x', name: 'Xx', category_id: cat.id, price_eur: 1 }], ['product_variants', { product_id: P, label: 'hack' }], ['orders', { customer_name: 'Xx', customer_email: 'a@b.be', subtotal_eur: 1, total_eur: 1 }],
  ['order_items', { product_name: 'x', unit_price_eur: 1, list_price_eur: 1, quantity: 1, line_total_eur: 1 }], ['product_categories', { slug: 'x', name: 'Xx' }], ['admins', { user_id: '22222222-2222-2222-2222-222222222222' }]]) {
  const r = await call('anon', 'POST', t, body); check(`anon kan niet schrijven naar ${t}`, denied(r), `${r.status} ${r.text}`);
}
{ const r = await call('anon', 'PATCH', `products?id=eq.${P}`, { price_eur: 1 }); check('anon kan productprijs niet wijzigen', denied(r), r.text); }
{ const r = await call('anon', 'PATCH', `product_variants?id=eq.${V['15 ml']}`, { price_eur: 1, stock_qty: 999 }); check('anon kan variantprijs/-voorraad niet wijzigen', denied(r), r.text); }
{ const r = await call('anon', 'DELETE', `products?id=eq.${P}`); check('anon kan product niet verwijderen', denied(r), r.text); }
for (const fn of ['is_admin', '_product_price', '_orders_status_guard', '_shop_touch', '_valid_product_attributes']) {
  const r = await rpc('anon', fn, fn === '_product_price' ? { p: {} } : {}); check(`anon kan ${fn}() niet uitvoeren`, denied(r) || r.status === 404, `${r.status} ${r.text}`);
}
{ const r = await rpc('user', 'is_admin'); check('gewone ingelogde gebruiker is geen admin (is_admin = false)', r.status === 200 && r.json === false, r.text); }
{ const r = await rpc('admin', 'is_admin'); check('admin is admin (is_admin = true)', r.status === 200 && r.json === true, r.text); }
check('gewone ingelogde gebruiker ziet geen orders', rows(await call('user', 'GET', 'orders?select=id')).length === 0);
{ const r = await call('user', 'POST', 'products', { slug: `x-${tag}`, name: 'Xx', category_id: cat.id, price_eur: 1 }); check('gewone gebruiker kan geen product aanmaken', denied(r), r.text); }
{ const r = await call('user', 'PATCH', `products?id=eq.${P}`, { price_eur: 1 }, REP); check('gewone gebruiker kan product niet wijzigen (0 rijen)', rows(r).length === 0 || denied(r), r.text); }

// ---------------------------------------------------------------- 4. prijs kan niet gemanipuleerd worden
console.log('\n4. Prijs, aantal en totaal kunnen niet gemanipuleerd worden');
{ const r = await order([{ product_id: P, variant_id: V['15 ml'], qty: 1 }], { extra: { p_price: 0.01 } }); check('onbekende parameter p_price wordt geweigerd (geen prijs in de functie)', !r.ok && [400, 404].includes(r.status), r.text); }
{ const r = await order([{ product_id: P, variant_id: V['15 ml'], qty: 1, price: 0.01, unit_price: 0.01, unit: 0.01 }]); check('prijs in de regels wordt genegeerd: totaal blijft € 29', r.ok && Number(r.json.total) === 29, r.text); await call('admin', 'PATCH', `orders?id=eq.${r.json.id}`, { status: 'geannuleerd' }); }
{ const r = await order([{ product_id: P, variant_id: V['15 ml'], qty: 1 }], { expected: 0.01 }); check('verkeerd verwacht totaal → prijs_gewijzigd', !r.ok && /prijs_gewijzigd:29/.test(msg(r)), r.text); }
{ const r = await order([{ product_id: P, variant_id: V['15 ml'], qty: 0 }]); check('aantal 0 geweigerd', !r.ok && /ongeldig_aantal/.test(msg(r)), r.text); }
{ const r = await order([{ product_id: P, variant_id: V['15 ml'], qty: -1 }]); check('negatief aantal geweigerd', !r.ok && /ongeldig_aantal/.test(msg(r)), r.text); }
{ const r = await order([{ product_id: P, variant_id: V['15 ml'], qty: 11 }]); check('aantal 11 geweigerd', !r.ok && /ongeldig_aantal/.test(msg(r)), r.text); }
{ const r = await order([{ product_id: P, qty: 1 }]); check('geen variant gekozen → kies_variant', !r.ok && /kies_variant/.test(msg(r)), r.text); }
{ const r = await order([{ product_id: P, variant_id: V['50 ml'], qty: 1 }]); check('uitgeschakelde variant niet bestelbaar', !r.ok && /product_niet_beschikbaar/.test(msg(r)), r.text); }
check('voorraad na alle geweigerde pogingen onveranderd (15 ml = 5)', (await adminStock('15 ml')) === 5);

// ---------------------------------------------------------------- 5. bestelling met varianten
console.log('\n5. Bestelling met gekozen varianten → order, order_items, voorraad');
const ord = await order([{ product_id: P, variant_id: V['15 ml'], qty: 2 }, { product_id: P, variant_id: V['70 ml'], qty: 1 }], { expected: 2 * 29 + 89 });
check('bestelling geplaatst: totaal = 2×29 + 89 = 147', ord.ok && Number(ord.json.total) === 147 && /^EL-\d+$/.test(ord.json.order_number), ord.text);
check('antwoord bevat variant per regel', ord.json?.items?.length === 2 && ord.json.items.some((i) => i.variant === '15 ml' && i.qty === 2) && ord.json.items.some((i) => i.variant === '70 ml'));
check('anon krijgt enkel ordernummer/totaal, geen klant- of voorraadgegevens terug', !/stock_qty|customer_email/.test(ord.text));
check('voorraad 15 ml: 5 → 3', (await adminStock('15 ml')) === 3);
check('voorraad 70 ml blijft leeg (niet bijgehouden)', (await adminStock('70 ml')) === null);
check('productvoorraad blijft 7 (varianten beheren hun eigen voorraad)', rows(await call('admin', 'GET', `products?id=eq.${P}&select=stock_qty`))[0]?.stock_qty === 7);
{ const r = await order([{ product_id: P, variant_id: V['15 ml'], qty: 4 }], { email: `e2e2+${tag}@example.test` }); check('meer dan voorraad geweigerd (onvoldoende_voorraad)', !r.ok && /onvoldoende_voorraad/.test(msg(r)), r.text); }
check('mislukte poging liet voorraad ongemoeid (15 ml = 3)', (await adminStock('15 ml')) === 3);
{ const r = await order([{ product_id: P, variant_id: V['30 ml'], qty: 2 }], { email: `e2e3+${tag}@example.test` }); check('30 ml ×2 lukt (voorraad 2 → 0)', r.ok, r.text); }
{ const r = await call('anon', 'GET', `product_variants?id=eq.${V['30 ml']}&select=label,is_available`); check('30 ml is voor anon nu "niet beschikbaar" (zonder voorraad te tonen)', rows(r)[0]?.is_available === false, r.text); }
{ const r = await order([{ product_id: P, variant_id: V['30 ml'], qty: 1 }], { email: `e2e4+${tag}@example.test` }); check('30 ml uitverkocht → bestelling geweigerd', !r.ok && /onvoldoende_voorraad/.test(msg(r)), r.text); }

// ---------------------------------------------------------------- 6. admin beheert de bestelling
console.log('\n6. Admin bekijkt en beheert de bestelling, daarna annulering');
const ao = await call('admin', 'GET', `orders?id=eq.${ord.json.id}&select=*,order_items(*)`);
const o = rows(ao)[0];
check('admin ziet bestelling met klantgegevens en regels', !!o && o.customer_email === `e2e+${tag}@example.test` && o.order_items.length === 2, ao.text);
const li = o?.order_items.find((i) => i.variant_label === '15 ml');
check('order_items bewaart variant_id, label, SKU, prijs en stock_effect', li && li.variant_id === V['15 ml'] && li.sku === `E2E-${tag}-15` && Number(li.unit_price_eur) === 29 && li.quantity === 2 && li.stock_effect === 'variant', JSON.stringify(li));
check('variant zonder voorraadbeheer: stock_effect leeg', o?.order_items.find((i) => i.variant_label === '70 ml')?.stock_effect === null);
{ const r = await call('admin', 'PATCH', `orders?id=eq.${ord.json.id}`, { status: 'in_behandeling', payment_status: 'betaald', payment_provider: 'contant', admin_notes: 'e2e' }, REP); check('admin wijzigt status en betaling', r.ok && rows(r)[0]?.status === 'in_behandeling', r.text); }
{ const r = await call('admin', 'PATCH', `orders?id=eq.${ord.json.id}`, { total_eur: 1 }); check('admin kan het orderbedrag niet achteraf wijzigen', denied(r), r.text); }
{ const r = await call('admin', 'PATCH', `orders?id=eq.${ord.json.id}`, { customer_email: 'x@y.be' }); check('admin kan klantgegevens niet achteraf wijzigen', denied(r), r.text); }
{ const r = await call('admin', 'DELETE', `orders?id=eq.${ord.json.id}`); check('admin kan een bestelling niet verwijderen', denied(r), r.text); }
{ const r = await call('user', 'PATCH', `orders?id=eq.${ord.json.id}`, { status: 'afgerond' }, REP); check('gewone gebruiker kan bestelling niet wijzigen', rows(r).length === 0 || denied(r), r.text); }
{ const r = await call('admin', 'PATCH', `orders?id=eq.${ord.json.id}`, { status: 'geannuleerd' }, REP); check('admin annuleert de bestelling', r.ok && rows(r)[0]?.status === 'geannuleerd', r.text); }
check('annulering zet voorraad terug: 15 ml 3 → 5', (await adminStock('15 ml')) === 5, await adminStock('15 ml'));
check('70 ml blijft zonder voorraadbeheer', (await adminStock('70 ml')) === null);
{ const r = await call('admin', 'PATCH', `orders?id=eq.${ord.json.id}`, { status: 'nieuw' }); check('geannuleerde bestelling kan niet heropend worden', !r.ok && /geannuleerd_is_definitief/.test(msg(r)), r.text); }
{ const r = await call('admin', 'PATCH', `orders?id=eq.${ord.json.id}`, { admin_notes: 'nogmaals', status: 'geannuleerd' }); check('nogmaals annuleren geeft geen dubbele voorraadherstelling', r.ok && (await adminStock('15 ml')) === 5); }

// ---------------------------------------------------------------- opruimen
console.log('\nOpruimen van testgegevens (enkel e2e-…)');
for (const e of [`e2e2+${tag}@example.test`, `e2e3+${tag}@example.test`]) { void e; }
const cleanup = await call('admin', 'DELETE', `products?slug=like.e2e-parfum-${tag}`);
check('testproduct (met varianten, afbeeldingen, attributen) verwijderd', cleanup.ok || cleanup.status === 204, cleanup.text);
await call('admin', 'DELETE', `brands?slug=eq.e2e-merk-${tag}`);
console.log('(Bestellingen zijn bewust niet verwijderbaar via de API; ze staan onder e2e+…@example.test en blijven in de testdatabase.)');

console.log(fails ? `\n${fails} test(s) MISLUKT` : '\nAlle integratietests geslaagd');
process.exit(fails ? 1 : 0);
