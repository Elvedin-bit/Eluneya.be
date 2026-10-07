// Haalt de officiële PostgREST-release (Windows) van GitHub en pakt ze uit in test/e2e/.bin/.
// Bron: https://github.com/PostgREST/postgrest/releases (v16.4, ~15 MB). Enkel nodig voor de lokale teststack.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bin = resolve(here, '.bin');
const URL_ = 'https://github.com/PostgREST/postgrest/releases/download/v16.4/postgrest-v16.4-windows-x86-64.zip';
const SHA256 = '29a5b56e5a09b7168bb552ef14aa7ade40bf0a81dd0687cffa86610187b89d78';   // gecontroleerd bij de eerste download

if (existsSync(resolve(bin, 'postgrest.exe'))) { console.log('postgrest.exe is er al.'); process.exit(0); }
mkdirSync(bin, { recursive: true });
const buf = Buffer.from(await (await fetch(URL_)).arrayBuffer());
const sum = createHash('sha256').update(buf).digest('hex');
if (sum !== SHA256) { console.error(`Onverwachte checksum ${sum}; niet uitgepakt.`); process.exit(1); }
writeFileSync(resolve(bin, 'postgrest.zip'), buf);
execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${resolve(bin, 'postgrest.zip')}' '${bin}'`]);
console.log('PostgREST v16.4 uitgepakt in', bin);
