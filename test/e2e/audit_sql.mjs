// Statische audit van supabase/schema.sql en supabase/shop.sql op destructieve statements. Voert niets uit.
// Faalt als er een statement bijkomt dat gegevens of structuur kan vernietigen en niet op de lijst van bekende, beoordeelde uitzonderingen staat.
//   node audit_sql.mjs            (vanuit test/e2e, of waar dan ook)
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let fails = 0;

// Patronen die in geen van beide bestanden mogen voorkomen (tenzij hieronder toegestaan).
const FORBIDDEN = [
  [/\bdrop\s+table\b/i, 'DROP TABLE'], [/\bdrop\s+schema\b/i, 'DROP SCHEMA'], [/\bdrop\s+(database|extension|role|type|view|sequence|index)\b/i, 'DROP van object'],
  [/\btruncate\b/i, 'TRUNCATE'], [/\balter\s+table\b[^;]*\bdrop\s+column\b/i, 'DROP COLUMN'], [/\balter\s+table\b[^;]*\balter\s+column\b[^;]*\btype\b/i, 'kolomtype wijzigen'],
  [/\balter\s+table\b[^;]*\brename\b/i, 'RENAME'], [/\bdrop\s+constraint\b/i, 'DROP CONSTRAINT'], [/\bcascade\b(?!\s*,|\s*\))/i, 'CASCADE (buiten een FK-definitie)'],
];
// Beoordeelde uitzonderingen: [bestand, regex van de regel, reden]
const ALLOWED = [
  ['schema.sql', /^\s*delete\s+from\s+public\.opening_hours\s*;/i, 'openingsuren worden bij elke run opnieuw gezet uit build.py (tabel is nieuw; bij herhaling gaan handmatige wijzigingen in die tabel verloren)'],
  ['schema.sql', /^\s*update\s+public\.treatments\s+set\s+active\s*=\s*false\s*;/i, 'behandelingen die niet meer in de lijst staan worden uitgeschakeld (niet verwijderd); de lijst wordt direct daarna opnieuw geactiveerd'],
  ['schema.sql', /^\s*update\s+public\.bookings\s+set\s+list_price_eur\s*=\s*price_eur\s+where\s+list_price_eur\s+is\s+null\s*;/i, 'vult enkel de nieuwe kolom list_price_eur voor bestaande boekingen'],
  ['schema.sql', /^\s*drop\s+function\s+if\s+exists\s+public\.book_appointment\(text, date, time, text, text, text, text\)\s*;/i, 'oude functiesignatuur vervangen door de uitgebreide versie (nieuwe functie staat er meteen onder)'],
  ['schema.sql', /execute\s+'drop policy if exists "(Admin volledige toegang|Publiek kan boeken)"/i, 'oude te ruime toegangsregels op appointments verwijderd (GEVOLG: de oude site kan niet meer boeken en elke ingelogde gebruiker verliest toegang; zie productieplan)'],
  ['schema.sql', /execute\s+'drop policy if exists "admin oude afspraken"/i, 'eigen policy van dit script, direct opnieuw aangemaakt (herhaalbaarheid)'],
  ['schema.sql', /execute\s+'drop policy if exists "admin beheert promotiebeelden"/i, 'eigen storage-policy van dit script, direct opnieuw aangemaakt (herhaalbaarheid)'],
  ['shop.sql', /execute\s+'drop policy if exists "admin beheert productbeelden"/i, 'eigen storage-policy van dit script, direct opnieuw aangemaakt (herhaalbaarheid)'],
];
const isDropIfExistsPolicyOrTrigger = (l) => /^\s*drop\s+(policy|trigger)\s+if\s+exists\b/i.test(l);   // gevolgd door een create van dezelfde naam

for (const file of ['schema.sql', 'shop.sql']) {
  const lines = readFileSync(resolve(repo, 'supabase', file), 'utf8').split(/\r?\n/);
  let stripped = lines.map((l) => l.replace(/--.*$/, ''));
  const found = [], tolerated = [];
  stripped.forEach((l, i) => {
    if (!l.trim()) return;
    const hit = FORBIDDEN.filter(([re]) => re.test(l)).map(([, n]) => n);
    // DELETE FROM en UPDATE zijn niet verboden, maar altijd rapportwaardig
    if (/^\s*delete\s+from\b/i.test(l)) hit.push('DELETE FROM');
    if (/^\s*update\s+public\./i.test(l)) hit.push('UPDATE');
    if (/^\s*drop\s+/i.test(l) && !isDropIfExistsPolicyOrTrigger(l) && !hit.includes('DROP van object')) hit.push('DROP');
    if (/execute\s+'drop policy/i.test(l)) hit.push('DROP POLICY (dynamisch)');
    if (!hit.length) return;
    const allow = ALLOWED.find(([f, re]) => f === file && re.test(l));
    (allow ? tolerated : found).push({ n: i + 1, text: l.trim().slice(0, 110), hit: hit.join('+'), why: allow && allow[2] });
  });
  // UPDATE binnen functiebody's (runtime, bv. voorraad) zijn bedoeld gedrag; hier alleen rapporteren
  const bodyUpdates = found.filter((f) => f.hit === 'UPDATE' && /^\s{2,}update\s+/i.test(lines[f.n - 1]));
  const real = found.filter((f) => !bodyUpdates.includes(f));
  console.log(`\n=== ${file} ===`);
  tolerated.forEach((t) => console.log(`  beoordeeld  r${t.n} [${t.hit}] ${t.text}\n              → ${t.why}`));
  bodyUpdates.forEach((t) => console.log(`  runtime     r${t.n} [UPDATE in functie/trigger] ${t.text}`));
  real.forEach((t) => console.log(`  ONBEOORDEELD r${t.n} [${t.hit}] ${t.text}`));
  const drops = stripped.filter((l) => isDropIfExistsPolicyOrTrigger(l)).length;
  console.log(`  + ${drops}× "drop policy/trigger if exists" (telkens direct opnieuw aangemaakt)`);
  if (real.length) { fails += real.length; console.log(`  ✗ ${real.length} onbeoordeeld(e) statement(s)`); } else console.log('  ✓ geen onbeoordeelde destructieve statements');
}
console.log(fails ? `\n${fails} onbeoordeeld` : '\nAudit geslaagd: geen DROP TABLE, TRUNCATE, DROP COLUMN, RENAME of kolomtype-wijziging; enkel de hierboven beoordeelde uitzonderingen.');
process.exit(fails ? 1 : 0);
