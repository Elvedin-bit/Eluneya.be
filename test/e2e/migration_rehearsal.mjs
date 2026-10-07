// Oefening (rehearsal) van de productiemigratie op WEGWERPDATABASES — raakt nooit Supabase.
//
// Bootst de productie na: de oude tabellen services + appointments (uit "Eluneya oudere versie/supabase-schema.sql") mét voorbeelddata,
// en voert dan de migratie uit in twee volgordes:
//   A  shop.sql eerst, dan schema.sql   (aanbevolen: shop.sql raakt de oude site niet)
//   B  schema.sql eerst, dan shop.sql
// Na elke stap draait supabase/verify.sql (dezelfde als je in productie gebruikt). Verder wordt gecontroleerd dat
//   * de oude tabellen en hun data ongewijzigd blijven (aantallen + checksum),
//   * wat de oude site doet (anon lezen/boeken) wel of niet meer werkt na elke stap,
//   * herhalen van de scripts niets verandert (idempotent),
//   * beide volgordes tot exact dezelfde database leiden.
// Gebruik (vanuit test/e2e):  node migration_rehearsal.mjs
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { supabaseBootstrapSql } from './bootstrap.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const read = (p) => readFileSync(p, 'utf8');
const OLD = read(resolve(repo, '..', 'Eluneya oudere versie/supabase-schema.sql'));
const SCHEMA = read(resolve(repo, 'supabase/schema.sql')), SHOP = read(resolve(repo, 'supabase/shop.sql')), VERIFY = read(resolve(repo, 'supabase/verify.sql'));
const ADMIN = '11111111-1111-1111-1111-111111111111', USER = '22222222-2222-2222-2222-222222222222';
let fails = 0;
const check = (name, cond, info = '') => { console.log((cond ? '  ok   ' : '  FOUT ') + name + (!cond && info ? `  [${String(info).slice(0, 300)}]` : '')); if (!cond) fails++; };

rmSync(resolve(here, '.data/rehearsal'), { recursive: true, force: true });
mkdirSync(resolve(here, '.data'), { recursive: true });
const server = new EmbeddedPostgres({ databaseDir: resolve(here, '.data/rehearsal'), user: 'postgres', password: 'postgres', port: 54330, persistent: false,
  initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
await server.initialise(); await server.start();

async function freshDb(name) {
  await server.createDatabase(name);
  const c = new pg.Client({ host: '127.0.0.1', port: 54330, user: 'postgres', password: 'postgres', database: name });
  await c.connect();
  c.on('notice', () => {});
  await c.query(supabaseBootstrapSql({ adminId: ADMIN, userId: USER }));
  await c.query(OLD);   // = de huidige productie: oude tabellen
  // Productie-achtige oude gegevens (7 behandelingen komen uit het oude script zelf). Afspraken: 1 toekomstig bevestigd, 1 voorbij, 1 geannuleerd.
  const wed = new Date(Date.now() + ((3 - new Date().getDay() + 7) % 7 + 14) * 86400000).toISOString().slice(0, 10);   // woensdag over 2–3 weken
  await c.query(`insert into public.appointments (service_name, appointment_date, appointment_time, client_name, client_email, client_phone, status) values
    ('Back in control', '${wed}', '14:00', 'Oude Klant', 'oud@example.test', '0470', 'confirmed'),
    ('Mind control', current_date - 30, '15:00', 'Voorbije Klant', 'voorbij@example.test', null, 'confirmed'),
    ('Mind control', '${wed}', '16:00', 'Geannuleerde Klant', 'geann@example.test', null, 'cancelled')`);
  return c;
}
const as = async (c, role, sql, uid) => {
  try {
    await c.query('reset role'); await c.query(`set role ${role}`);
    if (uid) await c.query(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', false)`);
    return { ok: true, rows: (await c.query(sql)).rows };
  } catch (e) { return { ok: false, err: e.message }; } finally { await c.query('reset role'); }
};
const checksum = async (c) => (await c.query(`select (select md5(string_agg(t::text, '|' order by t::text)) from public.services t) as s, (select count(*)::int from public.services) as sn,
  (select md5(string_agg(t::text, '|' order by t::text)) from public.appointments t) as a, (select count(*)::int from public.appointments) as an`)).rows[0];
const verify = async (c, label) => {
  const rows = (await c.query(VERIFY)).rows;
  const bad = rows.filter((r) => r.ok === false);
  console.log(`  verify.sql na "${label}": ${rows.filter((r) => r.ok === true).length} in orde, ${bad.length} niet in orde` + (bad.length ? ' → ' + [...new Set(bad.map((r) => r.area))].join(', ') : ''));
  if (process.env.REHEARSAL_VERBOSE) bad.forEach((r) => console.log(`        - ${r.area}: ${r.controle} [${String(r.detail).slice(0, 90)}]`));
  return { rows, bad, byArea: (a) => bad.filter((r) => r.area === a) };
};
const snapshot = async (c) => (await c.query(`select x from (
  select 'col:'||table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') x from information_schema.columns where table_schema='public'
  union all select 'con:'||conrelid::regclass||':'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace
  union all select 'idx:'||indexdef from pg_indexes where schemaname='public'
  union all select 'pol:'||schemaname||'.'||tablename||':'||policyname||':'||cmd||':'||array_to_string(roles,',')||':'||coalesce(qual,'')||':'||coalesce(with_check,'') from pg_policies where schemaname in ('public','storage')
  union all select 'grant:'||table_name||':'||grantee||':'||privilege_type from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated')
  union all select 'colgrant:'||table_name||':'||column_name||':'||grantee||':'||privilege_type from information_schema.column_privileges where table_schema='public' and grantee in ('anon','authenticated')
  union all select 'fn:'||p.oid::regprocedure||':'||p.prosecdef||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||has_function_privilege('anon',p.oid,'execute')||':'||has_function_privilege('authenticated',p.oid,'execute') from pg_proc p where pronamespace='public'::regnamespace
  union all select 'trg:'||tgrelid::regclass||':'||tgname from pg_trigger where not tgisinternal
  union all select 'bucket:'||id||':'||public||':'||coalesce(file_size_limit::text,'')||':'||coalesce(array_to_string(allowed_mime_types,','),'') from storage.buckets
) t order by x`)).rows.map((r) => r.x);

// De oude site (huidige live Netlify-versie) gebruikt: select services, insert appointments (anon), select public_booked_slots, admin = elke ingelogde gebruiker.
async function oldSiteChecks(c, label, expectOldBooking, expectOldAdmin) {
  const sv = await as(c, 'anon', 'select name from public.services where active');
  check(`[${label}] oude site: anon leest actieve behandelingen`, sv.ok && sv.rows.length === 7, sv.err || sv.rows.length);
  const bk = await as(c, 'anon', `insert into public.appointments (service_name, appointment_date, appointment_time, client_name, client_email, status) values ('Mind control', current_date + 60, '10:00', 'Oude Site Test', 'site@example.test', 'confirmed')`);
  check(`[${label}] oude site: anon kan boeken in appointments → ${expectOldBooking ? 'werkt' : 'GEBLOKKEERD'}`, bk.ok === expectOldBooking, bk.err || 'ok');
  if (bk.ok) await c.query(`delete from public.appointments where client_name = 'Oude Site Test'`);
  const sl = await as(c, 'anon', 'select * from public.public_booked_slots');
  check(`[${label}] oude site: view public_booked_slots blijft bestaan`, sl.ok, sl.err);
  if (label === 'start') check('[start] (bestaand gedrag) de oude view geeft anon geen rijen: geen select-policy op appointments', sl.ok && sl.rows.length === 0, sl.rows?.length);
  const ad = await as(c, 'authenticated', 'select count(*)::int n from public.appointments', USER);
  check(`[${label}] oude admin: gewone ingelogde gebruiker leest appointments → ${expectOldAdmin ? 'ja (oude regel)' : 'NEE (enkel admins)'}`, ad.ok && (ad.rows[0].n > 0) === expectOldAdmin, ad.err || JSON.stringify(ad.rows));
}

const results = {};
for (const [name, order] of [['a', ['shop', 'schema']], ['b', ['schema', 'shop']]]) {
  console.log(`\n=== Volgorde ${name.toUpperCase()}: ${order.map((o) => o + '.sql').join(' → ')} ===`);
  const c = await freshDb(`rehearsal_${name}`);
  const before = await checksum(c);
  console.log(`  start: ${before.sn} oude behandelingen, ${before.an} oude afspraken`);
  await verify(c, 'start (alleen oude tabellen)');
  await oldSiteChecks(c, 'start', true, true);
  let schemaApplied = false;
  for (const step of order) {
    await c.query(step === 'shop' ? SHOP : SCHEMA);
    if (step === 'schema') schemaApplied = true;
    console.log(`  → ${step}.sql uitgevoerd`);
    const after = await checksum(c);
    check(`[${step}] oude tabellen services/appointments ongewijzigd (aantallen + checksum)`, after.s === before.s && after.a === before.a && after.sn === before.sn && after.an === before.an, JSON.stringify({ before, after }));
    await verify(c, `${step}.sql`);
    await oldSiteChecks(c, step, !schemaApplied, !schemaApplied);
  }
  // Aida toevoegen als beheerder (stap uit het plan) en alles controleren
  await c.query(`insert into public.admins (user_id) values ('${ADMIN}') on conflict do nothing`);
  const v = await verify(c, 'admin toegevoegd');
  check(`[${name}] verify.sql: alles in orde na beide scripts + admin`, v.bad.length === 0, JSON.stringify(v.bad.map((r) => `${r.area}:${r.controle}:${r.detail}`)));
  // agenda en winkel werken
  const booked = (await as(c, 'anon', `select public.book_appointment('mind-control', (current_date + ((3 - extract(dow from current_date)::int + 7) % 7 + 14))::date, '18:00'::time, 'Nieuwe Klant', 'nieuw@example.test') as r`));
  check(`[${name}] agenda: book_appointment werkt voor anon`, booked.ok, booked.err);
  const slots = await as(c, 'anon', `select count(*)::int n from public.get_booked_slots(current_date, current_date + 28)`);
  check(`[${name}] agenda: get_booked_slots geeft bezette tijdsblokken`, slots.ok && slots.rows[0].n >= 2, slots.err || JSON.stringify(slots.rows));  // oude afspraak (overgezet) + nieuwe
  const migrated = (await c.query(`select count(*)::int n from public.bookings where notes like 'Overgezet uit vorige agenda%'`)).rows[0].n;
  check(`[${name}] agenda: toekomstige bevestigde oude afspraak is overgezet naar bookings (1 van de 3)`, migrated === 1, migrated);
  const adminSees = await as(c, 'authenticated', 'select count(*)::int n from public.bookings', ADMIN);
  const userSees = await as(c, 'authenticated', 'select count(*)::int n from public.bookings', USER);
  check(`[${name}] admin ziet afspraken, gewone gebruiker niet`, adminSees.ok && adminSees.rows[0].n >= 2 && userSees.ok && userSees.rows[0].n === 0, JSON.stringify({ adminSees, userSees }));
  const shopAnon = await as(c, 'anon', `select count(*)::int n from public.product_categories`);
  check(`[${name}] shop: anon leest de 6 basiscategorieën`, shopAnon.ok && shopAnon.rows[0].n === 6, shopAnon.err);
  const ordersAnon = await as(c, 'anon', 'select * from public.orders');
  check(`[${name}] shop: anon kan orders niet lezen`, !ordersAnon.ok && /permission denied/.test(ordersAnon.err), ordersAnon.err);
  // herhalen = geen verandering
  const snap1 = await snapshot(c);
  for (const step of [...order, ...order]) await c.query(step === 'shop' ? SHOP : SCHEMA);
  const snap2 = await snapshot(c);
  check(`[${name}] beide scripts nogmaals (2×) uitvoeren verandert de database niet`, JSON.stringify(snap1) === JSON.stringify(snap2), snap1.filter((x) => !snap2.includes(x)).slice(0, 3).join(' || '));
  const counts = (await c.query(`select (select count(*)::int from public.treatments) t, (select count(*)::int from public.opening_hours) o, (select count(*)::int from public.product_categories) c, (select count(*)::int from public.bookings) b`)).rows[0];
  check(`[${name}] herhaling dupliceert niets (behandelingen 10, uren 4, categorieën 6, bookings 2)`, counts.t === 10 && counts.o === 4 && counts.c === 6 && counts.b === 2, JSON.stringify(counts));
  results[name] = snap2;
  await c.end();
}

console.log('\n=== Vergelijking van beide volgordes ===');
const onlyA = results.a.filter((x) => !results.b.includes(x)), onlyB = results.b.filter((x) => !results.a.includes(x));
check(`volgorde A en B leveren dezelfde database op (${results.a.length} kenmerken: tabellen, kolommen, constraints, indexen, policies, rechten, functies, triggers, buckets)`, !onlyA.length && !onlyB.length, JSON.stringify({ onlyA: onlyA.slice(0, 3), onlyB: onlyB.slice(0, 3) }));

await server.stop();
console.log(fails ? `\n${fails} controle(s) MISLUKT` : '\nRehearsal geslaagd');
process.exit(fails ? 1 : 0);
