// Lokale testopstelling die zich gedraagt als de database + REST-laag van Supabase:
//   echte PostgreSQL 17 (embedded-postgres) + echte PostgREST + een proxy die /rest/v1 en CORS toevoegt (zoals de Supabase-gateway).
// Raakt NOOIT een echte Supabase: alles draait op localhost, met wegwerpgegevens in test/e2e/.data/.
//
// Gebruik (vanuit test/e2e):
//   npm install                  (eenmalig; embedded-postgres)
//   node fetch-postgrest.mjs     (eenmalig; officiële PostgREST-release van GitHub)
//   node stack.mjs [--mode=prod-sim|fresh|shop-only]
//     prod-sim  (standaard) bootst de huidige productie na: eerst de oude tabellen services/appointments, dan schema.sql, dan shop.sql
//     fresh     schema.sql, dan shop.sql
//     shop-only enkel shop.sql
// Schrijft test/e2e/.data/env.json (adressen en test-sleutels) en blijft draaien tot je Ctrl+C drukt.
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { supabaseBootstrapSql } from './bootstrap.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=prod-sim').split('=')[1];
const PG_PORT = 54329, REST_PORT = 3001, PROXY_PORT = 3100;
const dataDir = resolve(here, '.data/pg');
const ADMIN_ID = '11111111-1111-1111-1111-111111111111', USER_ID = '22222222-2222-2222-2222-222222222222';
const log = (...a) => console.log('[stack]', ...a);

const postgrestExe = resolve(here, '.bin/postgrest.exe');
if (!existsSync(postgrestExe)) { console.error('PostgREST ontbreekt: voer eerst "node fetch-postgrest.mjs" uit.'); process.exit(1); }

// ---- JWT's (HS256) met een willekeurig geheim dat enkel tijdens deze run bestaat
const secret = randomBytes(32).toString('hex');
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function jwt(claims) {
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ iss: 'eluneya-e2e', exp: Math.floor(Date.now() / 1000) + 7 * 86400, ...claims });
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}

// ---- PostgreSQL
rmSync(resolve(here, '.data'), { recursive: true, force: true });
mkdirSync(resolve(here, '.data'), { recursive: true });
const pgServer = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PG_PORT, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
await pgServer.initialise();
await pgServer.start();
await pgServer.createDatabase('eluneya_test');
const db = new pg.Client({ host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'postgres', database: 'eluneya_test' });
await db.connect();
db.on('notice', (n) => log('NOTICE:', n.message));

// Supabase-nabootsing: rollen, auth.uid() (zelfde definitie als Supabase), storage-stub, standaardrechten van nieuwe objecten
await db.query(supabaseBootstrapSql({ adminId: ADMIN_ID, userId: USER_ID }));

async function apply(file) {
  const sql = readFileSync(file, 'utf8');
  log('uitvoeren:', file.replace(repo, '').replace(/\\/g, '/'));
  await db.query(sql);
}
const files = {
  'prod-sim': ['../Eluneya oudere versie/supabase-schema.sql', 'supabase/schema.sql', 'supabase/shop.sql'],
  fresh: ['supabase/schema.sql', 'supabase/shop.sql'],
  'shop-only': ['supabase/shop.sql'],
}[mode];
if (!files) { console.error('onbekende modus', mode); process.exit(1); }
for (const f of files) await apply(f.startsWith('..') ? resolve(repo, '..', f.slice(3)) : resolve(repo, f));
await db.query(`insert into public.admins (user_id) values ('${ADMIN_ID}') on conflict do nothing`);

// ---- PostgREST
const libpq = resolve(here, 'node_modules/@embedded-postgres/windows-x64/native/bin');
const rest = spawn(postgrestExe, [], {
  env: { ...process.env, PATH: `${libpq};${process.env.PATH}`,
    PGRST_DB_URI: `postgres://authenticator:authenticator@127.0.0.1:${PG_PORT}/eluneya_test`, PGRST_DB_SCHEMAS: 'public',
    PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: secret, PGRST_SERVER_PORT: String(REST_PORT), PGRST_SERVER_HOST: '127.0.0.1', PGRST_DB_POOL: '5' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
rest.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));
rest.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(d));
for (let i = 0; i < 60; i++) {
  const up = await fetch(`http://127.0.0.1:${REST_PORT}/`).then(() => true).catch(() => false);
  if (up) break;
  await new Promise((r) => setTimeout(r, 250));
  if (i === 59) { console.error('PostgREST start niet'); process.exit(1); }
}

// ---- proxy: /rest/v1/* → PostgREST, met CORS (zoals de Supabase-gateway), zodat de echte site ertegen kan praten
const proxy = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'authorization, apikey, content-type, prefer, accept, accept-profile, content-profile, range, x-client-info', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'Access-Control-Expose-Headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (!req.url.startsWith('/rest/v1/')) { res.writeHead(404, cors); return res.end('alleen /rest/v1'); }
  const up = http.request({ host: '127.0.0.1', port: REST_PORT, method: req.method, path: req.url.slice('/rest/v1'.length), headers: { ...req.headers, host: `127.0.0.1:${REST_PORT}` } },
    (r) => {
      const h = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !k.toLowerCase().startsWith('access-control-')));   // PostgREST stuurt zelf ook CORS-headers
      res.writeHead(r.statusCode, { ...h, ...cors }); r.pipe(res); });
  up.on('error', () => { res.writeHead(502, cors); res.end('proxy-fout'); });
  req.pipe(up);
});
await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));

const env = {
  mode, apiUrl: `http://127.0.0.1:${PROXY_PORT}`, restUrl: `http://127.0.0.1:${PROXY_PORT}/rest/v1`, directRestUrl: `http://127.0.0.1:${REST_PORT}`,
  anonKey: jwt({ role: 'anon' }), adminJwt: jwt({ role: 'authenticated', sub: ADMIN_ID }), userJwt: jwt({ role: 'authenticated', sub: USER_ID }),
  adminId: ADMIN_ID, userId: USER_ID, pg: { host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'postgres', database: 'eluneya_test' },
};
writeFileSync(resolve(here, '.data/env.json'), JSON.stringify(env, null, 2));
log(`KLAAR (${mode}) — API: ${env.restUrl}  (env: test/e2e/.data/env.json). Ctrl+C om te stoppen.`);

async function stop() {
  log('afsluiten…');
  proxy.close(); rest.kill(); await db.end().catch(() => {}); await pgServer.stop().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
