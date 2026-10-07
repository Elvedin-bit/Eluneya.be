// Test van supabase/shop.sql (RLS, validatie, bestellen, voorraad) op een lokale wegwerp-PostgreSQL (PGlite).
// Raakt NOOIT een echte Supabase-database.
//
// Gebruik:  PGLITE_DIR=<map met node_modules/@electric-sql/pglite> node src/check_shop_sql.mjs
//   (eenmalig:  mkdir pgtest && cd pgtest && npm init -y && npm i @electric-sql/pglite)
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(process.env.PGLITE_DIR || '.');
const { PGlite } = await import(pathToFileURL(resolve(dir, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
const shopSql = readFileSync(resolve(here, '../supabase/shop.sql'), 'utf8');

const db = new PGlite();
const ADMIN = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
let fails = 0;

// --- Supabase-nabootsing: rollen, auth.uid(), storage, standaardrechten van nieuwe tabellen/functies
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant usage on schema public, auth to anon, authenticated;
  -- zoals Supabase: nieuwe objecten in public zijn standaard open voor anon/authenticated (shop.sql moet dat dichtdraaien)
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  insert into auth.users values ('${ADMIN}', 'aida@test.be'), ('${OTHER}', 'x@test.be');
`);
await db.exec(shopSql);
await db.exec(`insert into public.admins (user_id) values ('${ADMIN}')`);

async function run(sql, role = null, uid = null) {
  try {
    await db.exec('reset role');
    if (role) await db.exec(`set role ${role}`);
    await db.exec(`select set_config('request.jwt.claim.sub', '${uid || ''}', false)`);
    const multi = /;\s*\S/.test(sql);
    const res = multi ? (await db.exec(sql)).pop() : await db.query(sql);
    return { ok: true, rows: res.rows, count: res.affectedRows ?? res.rows.length };
  } catch (e) {
    return { ok: false, err: String(e.message) };
  } finally {
    await db.exec('reset role');
  }
}
function check(name, cond, info = '') {
  console.log((cond ? '  ok   ' : '  FOUT ') + name + (!cond && info ? `  [${info}]` : ''));
  if (!cond) fails++;
}
async function ok(name, sql, role, uid, test) {
  const r = await run(sql, role, uid);
  check(name, r.ok && (!test || test(r)), JSON.stringify(r).slice(0, 220));
  return r;
}
async function denied(name, sql, role, uid, why) {
  const r = await run(sql, role, uid);
  check(name, !r.ok && (!why || r.err.includes(why)), JSON.stringify(r).slice(0, 220));
}
const names = (r) => r.rows.map((x) => x.name).sort().join('|');

// --- Testgegevens (als eigenaar, niet via de API)
const cat = async (slug) => (await db.query(`select id from public.product_categories where slug='${slug}'`)).rows[0].id;
const parfums = await cat('parfums'), ebooks = await cat('e-books');
await db.exec(`
  insert into public.product_categories (slug, name, is_active) values ('verborgen', 'Verborgen', false);
  insert into public.brands (slug, name) values ('maison-test', 'Maison Test');
`);
const hidden = await cat('verborgen');
const ins = (slug, name, c, extra = '') => db.exec(`insert into public.products (slug, name, category_id, price_eur, is_active ${extra.split('|')[0] || ''})
  values ('${slug}', '${name}', '${c}', ${extra.split('|')[1] || 80}, true ${extra.split('|')[2] || ''})`);
await ins('a-parfum', 'A Parfum', parfums, ', track_stock, stock_qty, sale_price_eur|80|, true, 5, 60');
await db.exec(`insert into public.products (slug, name, category_id, price_eur, is_active) values ('b-inactief', 'B Inactief', '${parfums}', 50, false)`);
await ins('c-verborgen', 'C Verborgen cat', hidden);
await ins('d-uitverkocht', 'D Uitverkocht', parfums, ', availability|50|, \'out_of_stock\'');
await ins('e-aanvraag', 'E Aanvraag', parfums, ', availability|50|, \'on_request\'');
await ins('f-ebook', 'F Ebook', ebooks, ', product_type|15|, \'digital\'');
await ins('g-variant', 'G Variant', parfums, '|100|');
await ins('h-afgelopen-actie', 'H Actie voorbij', parfums, ', sale_price_eur, sale_ends_at|40|, 10, now() - interval \'1 day\'');
const pid = async (slug) => (await db.query(`select id from public.products where slug='${slug}'`)).rows[0].id;
const [A, B, C, D, E, F, G, H] = await Promise.all(['a-parfum', 'b-inactief', 'c-verborgen', 'd-uitverkocht', 'e-aanvraag', 'f-ebook', 'g-variant', 'h-afgelopen-actie'].map(pid));
await db.exec(`
  insert into public.product_variants (product_id, label, price_eur, stock_qty) values ('${G}', '30 ml', 60, 1), ('${G}', '50 ml', 90, null);
  insert into public.product_variants (product_id, label, is_active) values ('${G}', 'Oud', false);
  insert into public.product_attributes (product_id, data) values
    ('${A}', '{"fragrance_family":"Oriëntaals","notes":{"top":["bergamot"],"heart":["roos"],"base":["amber"]}}'),
    ('${B}', '{"fragrance_family":"Geheim"}');
  insert into public.product_images (product_id, url, is_primary) values ('${A}', 'https://x.test/a.jpg', true), ('${B}', 'https://x.test/b.jpg', true);
`);
const V30 = (await db.query(`select id from public.product_variants where label='30 ml'`)).rows[0].id;
const V50 = (await db.query(`select id from public.product_variants where label='50 ml'`)).rows[0].id;

console.log('RLS: bezoeker (anon) leest de catalogus');
await ok('anon ziet enkel actieve producten in actieve categorieën', 'select name from public.products', 'anon', null,
  (r) => names(r) === 'A Parfum|D Uitverkocht|E Aanvraag|F Ebook|G Variant|H Actie voorbij');
await ok('anon ziet enkel actieve categorieën', 'select slug from public.product_categories', 'anon', null,
  (r) => !r.rows.some((x) => x.slug === 'verborgen') && r.rows.length === 6);
await ok('anon ziet attributen/afbeeldingen van actieve producten niet van inactieve', 'select (select count(*) from public.product_attributes)::int a, (select count(*) from public.product_images)::int i', 'anon', null,
  (r) => r.rows[0].a === 1 && r.rows[0].i === 1);
await ok('anon ziet enkel actieve varianten', 'select label from public.product_variants', 'anon', null, (r) => r.rows.length === 2);
await ok('anon ziet is_available (D uitverkocht = false, A = true)', "select slug, is_available from public.products where slug in ('a-parfum','d-uitverkocht','e-aanvraag') order by slug", 'anon', null,
  (r) => r.rows.map((x) => x.is_available).join() === 'true,false,false');
await denied('anon kan stock_qty niet lezen', 'select stock_qty from public.products', 'anon', null, 'permission denied');
await denied('anon kan track_stock niet lezen', 'select track_stock from public.products', 'anon', null, 'permission denied');
await denied('anon select * op products geweigerd', 'select * from public.products', 'anon', null, 'permission denied');
await denied('anon kan voorraad van varianten niet lezen', 'select stock_qty from public.product_variants', 'anon', null, 'permission denied');
await denied('anon kan orders niet lezen', 'select * from public.orders', 'anon', null, 'permission denied');
await denied('anon kan order_items niet lezen', 'select * from public.order_items', 'anon', null, 'permission denied');
await denied('anon kan admins niet lezen', 'select * from public.admins', 'anon', null, 'permission denied');
await denied('anon kan volgnummer niet lezen/verhogen', "select nextval('public.order_number_seq')", 'anon', null, 'permission denied');
for (const [t, row] of [
  ['products', `(slug,name,category_id,price_eur) values ('x','Xx','${parfums}',1)`],
  ['product_categories', `(slug,name) values ('x','Xx')`],
  ['brands', `(slug,name) values ('x','Xx')`],
  ['product_images', `(product_id,url) values ('${A}','https://x.test/z.jpg')`],
  ['product_attributes', `(product_id,data) values ('${F}','{}')`],
  ['product_variants', `(product_id,label) values ('${A}','x')`],
  ['orders', `(customer_name,customer_email,subtotal_eur,total_eur) values ('Xx','a@b.be',1,1)`],
  ['order_items', `(order_id,product_name,unit_price_eur,list_price_eur,quantity,line_total_eur) values (gen_random_uuid(),'x',1,1,1,1)`],
]) {
  await denied(`anon kan niet toevoegen aan ${t}`, `insert into public.${t} ${row}`, 'anon', null, 'permission denied');
}
await denied('anon kan prijs niet wijzigen', "update public.products set price_eur = 1", 'anon', null, 'permission denied');
await denied('anon kan niet verwijderen (products)', 'delete from public.products', 'anon', null, 'permission denied');
await denied('anon kan interne _product_price niet aanroepen', 'select public._product_price(p) from public.products p limit 1', 'anon', null, 'permission denied');

console.log('RLS: ingelogd maar geen admin');
await ok('niet-admin ziet geen producten (geen eigen policy)', 'select * from public.products', 'authenticated', OTHER, (r) => r.rows.length === 0);
await denied('niet-admin kan geen product toevoegen', `insert into public.products (slug,name,category_id,price_eur) values ('x','Xx','${parfums}',1)`, 'authenticated', OTHER, 'row-level security');
await ok('niet-admin kan niets wijzigen (0 rijen)', "update public.products set price_eur = 1 returning id", 'authenticated', OTHER, (r) => r.rows.length === 0);
await ok('niet-admin ziet geen bestellingen', 'select * from public.orders', 'authenticated', OTHER, (r) => r.rows.length === 0);
await denied('niet-admin kan categorie niet toevoegen', "insert into public.product_categories (slug,name) values ('x','Xx')", 'authenticated', OTHER, 'row-level security');

console.log('Admin beheert de catalogus');
await ok('admin ziet ook inactieve producten en voorraad', 'select name, stock_qty from public.products', 'authenticated', ADMIN, (r) => r.rows.length === 8);
await ok('admin voegt product toe (inactief by default)', `insert into public.products (slug,name,category_id,price_eur) values ('nieuw-parfum','Nieuw parfum','${parfums}',70) returning is_active`, 'authenticated', ADMIN, (r) => r.rows[0].is_active === false);
await ok('admin voegt attributen toe', `insert into public.product_attributes (product_id,data) values ('${F}','{"notes":{"top":["a"]},"extra":{"x":1}}')`, 'authenticated', ADMIN);
await ok('admin wijzigt product', `update public.products set short_description='kort' where slug='nieuw-parfum' returning id`, 'authenticated', ADMIN, (r) => r.rows.length === 1);
await ok('updated_at wordt bijgewerkt', `select updated_at > created_at as u from public.products where slug='nieuw-parfum'`, null, null, (r) => r.rows[0].u === true);
await ok('admin verwijdert product', `delete from public.products where slug='nieuw-parfum' returning id`, 'authenticated', ADMIN, (r) => r.rows.length === 1);

console.log('Validatie');
const adm = (q, why, name) => denied(name, q, 'authenticated', ADMIN, why);
const base = (extra) => `insert into public.products (slug,name,category_id,price_eur${extra.cols || ''}) values ('${extra.slug || 'val-x'}','Valid',${"'" + parfums + "'"},${extra.price ?? 10}${extra.vals || ''})`;
await adm(base({ slug: 'Slecht Slug' }), 'products_slug_check', 'slug met hoofdletters/spaties geweigerd');
await adm(base({ price: -1 }), 'products_price_eur_check', 'negatieve prijs geweigerd');
await adm(base({ price: 20000 }), 'products_price_eur_check', 'prijs boven 10.000 geweigerd');
await adm(base({ cols: ',sale_price_eur', vals: ',10' }), 'products_sale_ok', 'actieprijs gelijk aan prijs geweigerd');
await adm(base({ cols: ',sale_price_eur', vals: ',12' }), 'products_sale_ok', 'actieprijs hoger dan prijs geweigerd');
await adm(base({ cols: ',compare_at_price_eur', vals: ',10' }), 'products_compare_ok', 'oude prijs niet hoger dan prijs geweigerd');
await adm(base({ cols: ',availability', vals: ",'bestaat-niet'" }), 'availability', 'ongeldige beschikbaarheid geweigerd');
await adm(base({ cols: ',stock_qty', vals: ',-3' }), 'stock_qty', 'negatieve voorraad geweigerd');
await adm(base({ cols: ',sale_price_eur,sale_starts_at,sale_ends_at', vals: ",5,now(),now() - interval '1 day'" }), 'products_sale_dates', 'einde actie voor start geweigerd');
await adm(base({ slug: 'a-parfum' }), 'products_slug_key', 'dubbele slug geweigerd');
await adm(base({ slug: 'sku-1', cols: ',sku', vals: ",'ABC'" }) + `; insert into public.products (slug,name,category_id,price_eur,sku) values ('sku-2','Valid','${parfums}',5,'abc')`, 'products_sku_uidx', 'dubbele SKU (hoofdletterongevoelig) geweigerd');
await adm(`insert into public.product_attributes (product_id,data) values ('${E}','{"notes":{"top":"bergamot"}}')`, 'product_attributes_data_check', 'noten moeten een lijst zijn');
await adm(`insert into public.product_attributes (product_id,data) values ('${E}','{"notes":{"onder":["x"]}}')`, 'product_attributes_data_check', 'onbekende notenlaag geweigerd');
await adm(`insert into public.product_attributes (product_id,data) values ('${E}','{"fragrance_family":123}')`, 'product_attributes_data_check', 'geurfamilie moet tekst zijn');
await adm(`insert into public.product_attributes (product_id,data) values ('${E}','[1]')`, 'product_attributes_data_check', 'attributen moeten een object zijn');
await adm(`insert into public.product_images (product_id,url) values ('${E}','javascript:alert(1)')`, 'product_images_url_check', 'afbeelding javascript: geweigerd');
await adm(`insert into public.product_images (product_id,url) values ('${E}','http://x.test/a.jpg')`, 'product_images_url_check', 'afbeelding http:// geweigerd');
await adm(`insert into public.product_images (product_id,url,is_primary) values ('${A}','https://x.test/2.jpg',true)`, 'product_images_primary_uidx', 'tweede hoofdafbeelding geweigerd');
await adm("insert into public.product_categories (slug,name,parent_id) select 'zelf','Zelf',id from public.product_categories where slug='parfums'; update public.product_categories set parent_id=id where slug='zelf'", 'product_categories_check', 'categorie kan niet haar eigen ouder zijn');

console.log('Bestellen (place_order)');
const items = (...l) => JSON.stringify(l.map(([p, q, v]) => ({ product_id: p, qty: q, ...(v ? { variant_id: v } : {}) })));
const order = (it, extra = {}) => {
  const a = { name: 'Klant Test', email: 'klant@test.be', phone: '0470', delivery: 'afhalen', street: null, postal: null, city: null, notes: null, consent: true, expected: null, ...extra };
  const q = (v) => (v == null ? 'null' : typeof v === 'boolean' || typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  return `select public.place_order('${it}'::jsonb, ${q(a.name)}, ${q(a.email)}, ${q(a.phone)}, ${q(a.delivery)}, ${q(a.street)}, ${q(a.postal)}, ${q(a.city)}, ${q(a.notes)}, ${q(a.consent)}, ${q(a.expected)}) as o`;
};
const stock = async () => (await db.query(`select stock_qty from public.products where slug='a-parfum'`)).rows[0].stock_qty;
const r1 = await ok('anon bestelt A×2 + ebook: totaal = 2×60 (actieprijs) + 15', order(items([A, 2], [F, 1]), { expected: 135 }), 'anon', null,
  (r) => Number(r.rows[0].o.total) === 135 && Number(r.rows[0].o.discount) === 40 && /^EL-\d+$/.test(r.rows[0].o.order_number));
check('voorraad A is verlaagd 5 → 3', (await stock()) === 3);
const oid = r1.rows[0].o.id;
const lines = (await db.query(`select product_name, unit_price_eur, list_price_eur, quantity from public.order_items where order_id='${oid}' order by product_name`)).rows;
check('orderregels bewaren naam + prijs-momentopname', lines.length === 2 && lines[0].product_name === 'A Parfum' && Number(lines[0].unit_price_eur) === 60 && Number(lines[0].list_price_eur) === 80, JSON.stringify(lines));
await ok('zelfde product in twee regels wordt samengevoegd', order(items([F, 1], [F, 2]), { email: 'merge@test.be' }), 'anon', null, (r) => Number(r.rows[0].o.total) === 45 && r.rows[0].o.items.length === 1);
await ok('actieprijs buiten de periode geldt niet (H = 40, niet 10)', order(items([H, 1]), { email: 'h@test.be', expected: 40 }), 'anon', null, (r) => Number(r.rows[0].o.total) === 40);
await denied('verkeerd verwacht totaal → prijs_gewijzigd (niets besteld)', order(items([A, 1]), { email: 'p@test.be', expected: 80 }), 'anon', null, 'prijs_gewijzigd:60');
check('voorraad onveranderd na geweigerde bestelling', (await stock()) === 3);
await denied('meer dan voorraad geweigerd', order(items([A, 4]), { email: 'v@test.be' }), 'anon', null, 'onvoldoende_voorraad');
check('voorraad onveranderd na onvoldoende voorraad', (await stock()) === 3);
await denied('mislukte bestelling laat geen halve order achter (twee regels: tweede mislukt)', order(items([F, 1], [A, 99]), { email: 'half@test.be' }), 'anon', null);
check('geen half order bewaard', (await db.query(`select count(*)::int c from public.orders where customer_email='half@test.be'`)).rows[0].c === 0);
await denied('inactief product niet bestelbaar', order(items([B, 1]), { email: 'i@test.be' }), 'anon', null, 'product_niet_beschikbaar');
await denied('product in inactieve categorie niet bestelbaar', order(items([C, 1]), { email: 'i@test.be' }), 'anon', null, 'product_niet_beschikbaar');
await denied('uitverkocht niet bestelbaar', order(items([D, 1]), { email: 'i@test.be' }), 'anon', null, 'product_niet_beschikbaar');
await denied('"op aanvraag" niet bestelbaar via winkelmand', order(items([E, 1]), { email: 'i@test.be' }), 'anon', null, 'product_niet_beschikbaar');
await denied('onbestaand product', order(items(['99999999-9999-9999-9999-999999999999', 1]), { email: 'i@test.be' }), 'anon', null, 'product_niet_beschikbaar');
await denied('lege bestelling', order('[]'), 'anon', null, 'lege_bestelling');
await denied('geen akkoord', order(items([F, 1]), { consent: false, email: 'c@test.be' }), 'anon', null, 'akkoord_vereist');
await denied('aantal 0 geweigerd', order(items([F, 0]), { email: 'q@test.be' }), 'anon', null, 'ongeldig_aantal');
await denied('aantal 11 geweigerd', order(items([F, 11]), { email: 'q@test.be' }), 'anon', null, 'ongeldig_aantal');
await denied('negatief aantal geweigerd', order(items([F, -2]), { email: 'q@test.be' }), 'anon', null, 'ongeldig_aantal');
await denied('ongeldig e-mailadres geweigerd', order(items([F, 1]), { email: 'geen-email' }), 'anon', null, 'ongeldige_gegevens');
await denied('verzenden zonder adres geweigerd', order(items([F, 1]), { email: 'z@test.be', delivery: 'verzenden' }), 'anon', null, 'adres_vereist');
await ok('verzenden mét adres lukt', order(items([F, 1]), { email: 'z@test.be', delivery: 'verzenden', street: 'Straat 1', postal: '8560', city: 'Wevelgem' }), 'anon', null);
await denied('onbekende leveringswijze geweigerd', order(items([F, 1]), { email: 'z@test.be', delivery: 'drone' }), 'anon', null, 'ongeldige_gegevens');
await denied('variant verplicht als er varianten zijn', order(items([G, 1]), { email: 'g@test.be' }), 'anon', null, 'kies_variant');
await denied('variant van ander product geweigerd', order(items([F, 1, V30]), { email: 'g@test.be' }), 'anon', null, 'product_niet_beschikbaar');
await ok('variant 30 ml (eigen prijs 60, voorraad 1) lukt', order(items([G, 1, V30]), { email: 'g@test.be', expected: 60 }), 'anon', null, (r) => Number(r.rows[0].o.total) === 60);
await denied('variant 30 ml nu uitverkocht (voorraad 0)', order(items([G, 1, V30]), { email: 'g2@test.be' }), 'anon', null, 'onvoldoende_voorraad');
await ok('variant 50 ml (voorraad niet bijgehouden) lukt', order(items([G, 2, V50]), { email: 'g3@test.be', expected: 180 }), 'anon', null);
await ok('variant is nu niet meer beschikbaar voor anon (is_available=false)', "select is_available from public.product_variants where label='30 ml'", 'anon', null, (r) => r.rows[0].is_available === false);
for (let i = 1; i <= 3; i++) await ok(`max. openstaande aanvragen per e-mail (${i}/3)`, order(items([F, 1]), { email: 'spam@test.be' }), 'anon', null);
await denied('vierde openstaande aanvraag geweigerd', order(items([F, 1]), { email: 'SPAM@test.be' }), 'anon', null, 'te_veel_bestellingen');
await denied('anon kan place_order-functie _product_price niet misbruiken', 'select public._product_price(p) from public.products p limit 1', 'anon', null, 'permission denied');

console.log('Varianten');
// Product met actieprijs en drie varianten: A15 erft de (actie)prijs en heeft voorraad 2, B70 heeft een eigen prijs en geen voorraadbeheer, C30 is uitgeschakeld.
await ins('i-multi', 'I Multi', parfums, ', track_stock, stock_qty, sale_price_eur|80|, true, 7, 60');
const I = await pid('i-multi');
await db.exec(`insert into public.product_variants (product_id, label, volume_ml, sku, price_eur, stock_qty, sort_order, is_active) values
  ('${I}', '15 ml', 15, 'I-15', null, 2, 1, true), ('${I}', '70 ml', 70, 'I-70', 100, null, 2, true), ('${I}', '30 ml', 30, 'I-30', 70, 5, 3, false)`);
const VI15 = (await db.query(`select id from public.product_variants where sku='I-15'`)).rows[0].id;
const VI70 = (await db.query(`select id from public.product_variants where sku='I-70'`)).rows[0].id;
const VI30 = (await db.query(`select id from public.product_variants where sku='I-30'`)).rows[0].id;
const vstock = async (sku) => (await db.query(`select stock_qty from public.product_variants where sku='${sku}'`)).rows[0].stock_qty;
const pstock = async (slug) => (await db.query(`select stock_qty from public.products where slug='${slug}'`)).rows[0].stock_qty;
await ok('anon ziet volume_ml, label en SKU van actieve varianten (niet de uitgeschakelde)', `select label, volume_ml, sku from public.product_variants where product_id='${I}' order by sort_order`, 'anon', null,
  (r) => r.rows.map((x) => `${x.label}:${Number(x.volume_ml)}:${x.sku}`).join('|') === '15 ml:15:I-15|70 ml:70:I-70');
await denied('anon kan voorraad van varianten niet lezen', `select stock_qty from public.product_variants where product_id='${I}'`, 'anon', null, 'permission denied');
await denied('volume 0 geweigerd', `insert into public.product_variants (product_id,label,volume_ml) values ('${F}','Nul',0)`, 'authenticated', ADMIN, 'volume_ml');
await denied('negatief volume geweigerd', `insert into public.product_variants (product_id,label,volume_ml) values ('${F}','Min',-5)`, 'authenticated', ADMIN, 'volume_ml');
await denied('dubbele variantnaam bij hetzelfde product geweigerd (hoofdletter/spatie-ongevoelig)', `insert into public.product_variants (product_id,label) values ('${I}',' 15 ML ')`, 'authenticated', ADMIN, 'product_variants_label_uidx');
await ok('dezelfde variantnaam bij een ander product mag wel', `insert into public.product_variants (product_id,label) values ('${F}','15 ml') returning id`, 'authenticated', ADMIN);
await denied('dubbele variant-SKU geweigerd', `insert into public.product_variants (product_id,label,sku) values ('${F}','Extra','i-15')`, 'authenticated', ADMIN, 'product_variants_sku_uidx');
await denied('variantprijs boven 10.000 geweigerd', `insert into public.product_variants (product_id,label,price_eur) values ('${F}','Duur',20000)`, 'authenticated', ADMIN, 'price_eur');
await denied('negatieve variantvoorraad geweigerd', `insert into public.product_variants (product_id,label,stock_qty) values ('${F}','Neg',-1)`, 'authenticated', ADMIN, 'stock_qty');
await denied('niet-admin kan geen variant toevoegen', `insert into public.product_variants (product_id,label) values ('${F}','Zomaar')`, 'authenticated', OTHER, 'row-level security');
await db.exec(`delete from public.product_variants where product_id='${F}'`); // opruimen (F is het e-book)

await denied('geen variant gekozen bij product met varianten', order(items([I, 1]), { email: 'v1@test.be' }), 'anon', null, 'kies_variant');
await denied('uitgeschakelde variant niet bestelbaar', order(items([I, 1, VI30]), { email: 'v1@test.be' }), 'anon', null, 'product_niet_beschikbaar');
const rv = await ok('variant zonder eigen prijs erft de actieprijs van het product (60)', order(items([I, 1, VI15]), { email: 'v2@test.be', expected: 60 }), 'anon', null, (r) => Number(r.rows[0].o.total) === 60);
await ok('variant met eigen prijs negeert de actieprijs (100)', order(items([I, 2, VI70]), { email: 'v3@test.be', expected: 200 }), 'anon', null, (r) => Number(r.rows[0].o.total) === 200);
check('voorraad van variant 15 ml verlaagd 2 → 1', (await vstock('I-15')) === 1);
check('productvoorraad onaangeroerd bij varianten (7)', (await pstock('i-multi')) === 7);
check('variant 70 ml zonder voorraadbeheer blijft leeg (null)', (await vstock('I-70')) === null);
const ri = (await db.query(`select variant_id, variant_label, sku, unit_price_eur, list_price_eur, stock_effect from public.order_items where order_id='${rv.rows[0].o.id}'`)).rows[0];
check('order_items bewaart variant (id, label, SKU, prijzen, stock_effect)', ri.variant_id === VI15 && ri.variant_label === '15 ml' && ri.sku === 'I-15' && Number(ri.unit_price_eur) === 60 && Number(ri.list_price_eur) === 80 && ri.stock_effect === 'variant', JSON.stringify(ri));
check('variant zonder voorraadbeheer: geen stock_effect', (await db.query(`select stock_effect from public.order_items where variant_id='${VI70}'`)).rows[0].stock_effect === null);
await ok('twee varianten van hetzelfde product = twee orderregels', order(items([I, 1, VI15], [I, 1, VI70]), { email: 'v4@test.be', expected: 160 }), 'anon', null, (r) => r.rows[0].o.items.length === 2 && Number(r.rows[0].o.total) === 160);
check('15 ml voorraad nu 0', (await vstock('I-15')) === 0);
await denied('variant 15 ml uitverkocht', order(items([I, 1, VI15]), { email: 'v5@test.be' }), 'anon', null, 'onvoldoende_voorraad');
await ok('anon ziet 15 ml nu als niet beschikbaar', `select is_available from public.product_variants where sku='I-15'`, 'anon', null, (r) => r.rows[0].is_available === false);
await denied('variant meegeven bij product zonder varianten geweigerd', order(items([F, 1, VI15]), { email: 'v5@test.be' }), 'anon', null, 'product_niet_beschikbaar');
// annuleren zet de variantvoorraad terug, niet de productvoorraad
const vOrders = (await db.query(`select distinct o.id from public.orders o join public.order_items i on i.order_id=o.id where i.variant_id='${VI15}'`)).rows.map((x) => x.id);
for (const id of vOrders) await ok('admin annuleert order met variant', `update public.orders set status='geannuleerd' where id='${id}' returning id`, 'authenticated', ADMIN);
check('annulering zet 15 ml terug (0 → 2)', (await vstock('I-15')) === 2, String(await vstock('I-15')));
check('productvoorraad blijft 7 na annulering', (await pstock('i-multi')) === 7);
// verwijderde variant: annulering mag de productvoorraad niet ophogen
await db.exec(`insert into public.products (slug,name,category_id,price_eur,is_active,track_stock,stock_qty) values ('k-del','K Del','${parfums}',50,true,true,7)`);
const K = await pid('k-del');
await db.exec(`insert into public.product_variants (product_id,label,stock_qty) values ('${K}','Weg',3)`);
const VK = (await db.query(`select id from public.product_variants where product_id='${K}'`)).rows[0].id;
const rk = await ok('order op variant van K (voorraad 3 → 1)', order(items([K, 2, VK]), { email: 'v6@test.be' }), 'anon', null);
await db.exec(`delete from public.product_variants where id='${VK}'`);
await ok('admin annuleert order van verwijderde variant', `update public.orders set status='geannuleerd' where id='${rk.rows[0].o.id}' returning id`, 'authenticated', ADMIN);
check('productvoorraad van K blijft 7 (geen foutieve herstelling)', (await pstock('k-del')) === 7, String(await pstock('k-del')));
// product waarvan alle varianten uitgeschakeld zijn is niet bestelbaar (geen terugval op productprijs)
await db.exec(`insert into public.products (slug,name,category_id,price_eur,is_active) values ('l-alles-uit','L Alles uit','${parfums}',50,true)`);
const L = await pid('l-alles-uit');
await db.exec(`insert into public.product_variants (product_id,label,is_active) values ('${L}','Uit',false)`);
await denied('product met enkel uitgeschakelde varianten niet bestelbaar', order(items([L, 1]), { email: 'v7@test.be' }), 'anon', null, 'product_niet_beschikbaar');
// combinatie in één bestelling: product met productvoorraad + variant
const before = await stock();
const rm = await ok('gemengde bestelling (productvoorraad + variant + zonder voorraad)', order(items([A, 1], [I, 1, VI70], [F, 1]), { email: 'v8@test.be', expected: 60 + 100 + 15 }), 'anon', null, (r) => Number(r.rows[0].o.total) === 175);
check('gemengde bestelling verlaagt A met 1', (await stock()) === before - 1);
await ok('gemengde bestelling annuleren', `update public.orders set status='geannuleerd' where id='${rm.rows[0].o.id}' returning id`, 'authenticated', ADMIN);
check('annulering herstelt A en laat de rest ongemoeid', (await stock()) === before && (await vstock('I-70')) === null && (await pstock('i-multi')) === 7);

console.log('Beheer van bestellingen');
await ok('admin ziet bestelling + regels', `select (select count(*) from public.orders)::int o, (select count(*) from public.order_items)::int i`, 'authenticated', ADMIN, (r) => r.rows[0].o >= 5 && r.rows[0].i >= 5);
await ok('admin wijzigt status en betaalstatus', `update public.orders set status='in_behandeling', payment_status='betaald', payment_provider='contant', admin_notes='ok' where id='${oid}' returning id`, 'authenticated', ADMIN, (r) => r.rows.length === 1);
await denied('admin kan bedrag niet achteraf wijzigen', `update public.orders set total_eur = 1 where id='${oid}'`, 'authenticated', ADMIN, 'permission denied');
await denied('admin kan klantnaam niet achteraf wijzigen', `update public.orders set customer_name = 'Iemand' where id='${oid}'`, 'authenticated', ADMIN, 'permission denied');
await denied('admin kan bestelregel niet wijzigen', `update public.order_items set quantity = 9`, 'authenticated', ADMIN, 'permission denied');
await denied('admin kan bestelling niet verwijderen', `delete from public.orders where id='${oid}'`, 'authenticated', ADMIN, 'permission denied');
await denied('ongeldige status geweigerd', `update public.orders set status='verzonden-naar-mars' where id='${oid}'`, 'authenticated', ADMIN, 'orders_status_check');
await ok('niet-admin kan geen bestelling wijzigen (0 rijen)', `update public.orders set status='afgerond' returning id`, 'authenticated', OTHER, (r) => r.rows.length === 0);
await ok('annuleren zet voorraad terug (3 → 5)', `update public.orders set status='geannuleerd' where id='${oid}' returning id`, 'authenticated', ADMIN);
check('voorraad A is hersteld naar 5', (await stock()) === 5, String(await stock()));
await denied('geannuleerde bestelling kan niet heropend worden', `update public.orders set status='nieuw' where id='${oid}'`, 'authenticated', ADMIN, 'geannuleerd_is_definitief');
await ok('nogmaals annuleren zet voorraad niet dubbel terug', `update public.orders set admin_notes='x', status='geannuleerd' where id='${oid}' returning id`, 'authenticated', ADMIN);
check('voorraad A blijft 5', (await stock()) === 5);

console.log('Idempotentie');
await db.exec(`update public.product_categories set name='Parfums & geuren' where slug='parfums'`);
let rerun = null;
try { await db.exec(shopSql); await db.exec(shopSql); } catch (e) { rerun = e.message; }
check('shop.sql twee keer opnieuw uitvoeren geeft geen fout', rerun === null, rerun || '');
check('aangepaste categorienaam blijft behouden', (await db.query(`select name from public.product_categories where slug='parfums'`)).rows[0].name === 'Parfums & geuren');
check('gegevens blijven behouden na herhaling', (await db.query('select count(*)::int c from public.products')).rows[0].c === 11);
await denied('na herhaling blijft anon geblokkeerd op orders', 'select * from public.orders', 'anon', null, 'permission denied');
await denied('na herhaling blijft stock_qty privé', 'select stock_qty from public.products', 'anon', null, 'permission denied');

console.log(fails ? `\n${fails} test(s) MISLUKT` : '\nAlle tests geslaagd');
process.exit(fails ? 1 : 0);
