# Productieplan: agenda, promoties en webshop live zetten

**Status: voorbereid, NIETS uitgevoerd op productie.** Geen SQL op het project "Eluneya" (`jdfcheqimbxffxldedey`), geen productiegegevens
aangeraakt, niets gepusht. Alles hieronder is vooraf geoefend op wegwerpdatabases (zie §9).

---

## 1. Samenvatting en aanbeveling

* De huidige productiedatabase bevat **enkel de oude tabellen** `services` en `appointments` (+ de view `public_booked_slots`).
  De agenda, promoties en admin van de nieuwe site (`schema.sql`) staan er **niet** in; de webshop (`shop.sql`) ook niet.
* **`shop.sql` is veilig om als eerste uit te voeren**: het raakt de oude tabellen en de oude site niet (geoefend: de oude site boekt en
  leest daarna nog precies hetzelfde).
* **`schema.sql` heeft één bewust gevolg dat je moet plannen**: het trekt de oude, te ruime toegangsregels op `appointments` in. De
  **huidige live Netlify-site** (`eluneya-be.netlify.app`, de oude eenpagina-site) kan daarna niet meer boeken en haar admin werkt niet meer
  voor een gewone ingelogde gebruiker. Voer `schema.sql` dus uit **vlak voor of samen met** het live zetten van de nieuwe site.
* Aanbevolen volgorde: **A: `shop.sql` → (Aida als beheerder) → `schema.sql` → push van de site → eerste producten → catalogus publiceren.**
  De omgekeerde volgorde (B) levert een identieke database op (geoefend), maar A houdt de huidige site het langst werkend.
* Het domein `eluneya.be` wordt vandaag door **SalonRound** bediend, niet door deze repo/Netlify. Het live zetten op dat domein is een aparte DNS-beslissing buiten dit plan.

## 2. Huidige toestand (alleen gelezen, 7 okt 2026)

| Onderdeel | Bevinding |
|---|---|
| Supabase-project "Eluneya" (eu-west-1, org *Bprojects*, **free plan**) | `public`: enkel `services` en `appointments` (RLS aan, **0 rijen** bij de laatste controle). Geen migraties, geen branches. |
| Project "HimalayanWok website" | andere zaak, gepauzeerd; **niet aanraken**. |
| `eluneya.be` | SalonRound (derde partij). |
| `eluneya-be.netlify.app` (Netlify-project `eluneya-be`) | **oude eenpagina-site**: gebruikt `appointments` (insert door anon, admin), `services` en `public_booked_slots` rechtstreeks. `afspraak.html` en `/shop/` bestaan er niet (404). |
| Git (`Elvedin-bit/Eluneya.be`) | Lokaal staan er **onge-pushte commits** (shop, varianten, tests, plan). `origin/main` eindigt op `182ef03` (promoties). Er is niet gepusht. |
| Oude `public_booked_slots` | view met `security_invoker`; omdat anon geen select-policy op `appointments` heeft, geeft ze voor bezoekers al geen rijen terug (bestaand gedrag, niet nieuw). |

**Voor je begint, opnieuw controleren** (alleen lezen, in de SQL Editor): `select count(*) from public.services; select count(*) from public.appointments;`
Zijn er rijen, exporteer ze eerst (Table Editor → Export CSV). Het free plan heeft geen automatische back-ups om op te vertrouwen.

## 3. Welke bestanden, in welke volgorde

Alles uitvoeren in Supabase-dashboard → **SQL Editor** → bestand plakken → **Run**. Daarna telkens `supabase/verify.sql` (alleen lezen).

| Stap | Bestand | Doel | Raakt oude site? |
|---|---|---|---|
| 0 | `supabase/verify.sql` | Basislijn vóór de migratie (verwacht: alle `veiligheid`-rijen true; `agenda`/`shop` false) | nee |
| 1 | `supabase/shop.sql` | Webshop: tabellen, RLS, `place_order`, opslagmap `products`, 6 basiscategorieën | **nee** |
| 1b | `insert into public.admins (user_id) select id from auth.users where email = 'HAAR-EMAIL' on conflict do nothing;` | Aida als beheerder (haar account bestaat al onder Authentication → Users) | nee |
| 2 | `supabase/schema.sql` | Agenda, promoties, admin, opslagmap `promotions`, overzetten oude afspraken | **ja: oude site kan niet meer boeken** (zie §5) |
| 3 | `git push` | Nieuwe site naar Netlify (shop blijft onzichtbaar tot er producten zijn) | vervangt de oude site |
| 4 | Admin → Shop → producten toevoegen, dan `python3 src/build.py --fetch-catalog`, commit, push | Shop zichtbaar maken | nee |

`schema.sql` en `shop.sql` zijn **idempotent** (opnieuw uitvoeren is veilig) en onafhankelijk (`shop.sql` maakt zelf `admins` en
`is_admin()` aan, identiek aan `schema.sql`). Stop bij een fout, lees de melding, voer het bestand opnieuw uit; er zijn geen halve toestanden die je met de hand moet opruimen.

Instellingen buiten SQL: Authentication → Sign In / Providers → **"Allow new users to sign up" uit**. Optioneel: e-mailmelding via `supabase/functions/booking-notify`.

## 4. Wat herstelt `schema.sql` (agenda en promoties)

| Regels | Onderdeel |
|---|---|
| 32–77 | `treatments`, `opening_hours`, `closures`, `bookings` (met exclusion constraint tegen dubbele boekingen) |
| 79–159 | `promotions` (+ trigger) en promotiekolommen op `bookings` |
| 161–179 | RLS aan; anon: enkel lopende promoties en enkel publieke kolommen (de promocode zelf niet) |
| 181–208 | Gegevens: 10 behandelingen, 4 openingsdagen (gegenereerd door `build.py`) |
| 210–342 | `get_booked_slots`, `get_price_quote` en interne promotiefuncties (niet publiek aanroepbaar) |
| 344–480 | `book_appointment` (prijs en korting server-side) + grants |
| 482–533 | `admins`, `is_admin()`, admin-policies op bookings/closures/treatments/opening_hours/promotions |
| 535–552 | Opslagmap `promotions` (openbaar lezen, enkel admins schrijven) |
| 554–606 | **Overzetting van de oude site**: oude policies op `appointments` vervangen door "enkel admins"; toekomstige bevestigde afspraken worden **gekopieerd** naar `bookings` (de oude rijen blijven staan) |

## 5. Wat voegt `shop.sql` toe

Regels 24–44 `admins`/`is_admin()` (identiek, `if not exists`/`create or replace`) · 58–226 categorieën, merken, producten, attributen (jsonb), afbeeldingen,
varianten · 227–315 orders, order_items, statuswachter (voorraad terug bij annulering) · 316–401 RLS en kolomrechten ·
402–419 prijsfunctie · 420–576 `place_order` · 577–595 opslagmap `products` · 596–605 zes basiscategorieën (`on conflict do nothing`).

## 6. Bestaande objecten die worden aangeraakt

| Object | Door | Wat gebeurt er |
|---|---|---|
| `public.services` (oud) | niets | **Niet aangeraakt.** |
| `public.appointments` (oud) | `schema.sql` r.567–571 | Policies `Admin volledige toegang` en `Publiek kan boeken` worden **verwijderd**, `admin oude afspraken` (enkel admins) wordt aangemaakt. **Rijen blijven ongewijzigd** (aantallen + checksum gecontroleerd). |
| `public.public_booked_slots` (view) | niets | Blijft bestaan. |
| `public.admins`, `public.is_admin()` | beide | Aangemaakt als ze er niet zijn (identieke definitie in beide bestanden). |
| `storage.buckets` / `storage.objects` | beide | Twee nieuwe mappen (`promotions`, `products`) en twee admin-only policies met eigen namen. Geen bestaande mappen of policies. |
| `auth.users` | niets | Enkel gelezen (foreign key en e-mail van Aida bij het toevoegen aan `admins`). |

## 7. Controle op destructieve statements (`node test/e2e/audit_sql.mjs`)

Geen `DROP TABLE`, `DROP SCHEMA`, `TRUNCATE`, `DROP COLUMN`, `RENAME`, kolomtype-wijziging of `CASCADE` buiten FK-definities. Wat er wél staat:

| Bestand | Statement | Beoordeling |
|---|---|---|
| schema.sql r.200 | `delete from public.opening_hours;` | **Risico (laag nu, middel bij herhaling):** wist en herzet de openingsuren bij *elke* run. Nu is de tabel nieuw. Als Aida de openingsuren later rechtstreeks in de database aanpast en je `schema.sql` opnieuw uitvoert, gaan die wijzigingen verloren: pas openingsuren aan in `src/build.py`. |
| schema.sql r.183 | `update public.treatments set active = false;` | Zet alle behandelingen uit en activeert daarna de 10 uit de lijst opnieuw. Een extra behandeling die enkel in de database staat wordt dus **uitgeschakeld** (niet verwijderd). Nu: tabel is nieuw. |
| schema.sql r.153 | `update public.bookings set list_price_eur = price_eur …` | Vult enkel de nieuwe kolom voor bestaande boekingen. |
| schema.sql r.567, 571 | `drop policy "Admin volledige toegang"`, `"Publiek kan boeken"` op `appointments` | **Bedoeld, maar met gevolg voor de oude site** (zie §1): die kan daarna niet meer boeken en haar admin werkt enkel voor beheerders. Zonder deze stap zou elke ingelogde gebruiker alle afspraken kunnen lezen en wijzigen. |
| schema.sql r.347 | `drop function if exists book_appointment(7 params)` | Oude signatuur; de uitgebreide versie staat er direct onder. Bestond nog niet in productie. |
| beide | `drop policy/trigger if exists …` (9× en 21×) | Telkens direct opnieuw aangemaakt met dezelfde naam; zorgt voor herhaalbaarheid. |
| shop.sql | `update … set stock_qty` (5×) | Runtime-gedrag in `place_order` en de annuleringstrigger, geen migratiestap. |
| beide | `revoke all …` | Trekt rechten in op **nieuwe** objecten (gewenst). |

Overige aandachtspunten uit de audit: de legacy-overzetting **kopieert** (verwijdert niets) en slaat overlappende of ongeldige oude afspraken over met een `NOTICE`
(lees de melding in de SQL Editor: "N afspraak/afspraken overgezet"). Een oude afspraak met een behandelingsnaam die niet herkend wordt, krijgt de duur van het
intakegesprek (30 min); controleer de overgezette afspraken in de admin.

## 8. Risico's

| # | Risico | Impact | Mitigatie |
|---|---|---|---|
| 1 | `schema.sql` blokkeert de oude site (boeken + admin) | Hoog zodra de oude site echt gebruikt wordt | Uitvoeren vlak vóór de push; beheerders vooraf in `admins`; communiceer even geen online boekingen. Terugdraaien: §10. |
| 2 | Niemand is beheerder → admin toont "Geen toegang" | Midden | Stap 1b vóór stap 2; `verify.sql` meldt "minstens één beheerder". |
| 3 | `delete from opening_hours` bij herhaling | Laag | Openingsuren enkel in `build.py` beheren. |
| 4 | Oude afspraken met onbekende behandeling → 30 min | Laag | Na stap 2 de overgezette afspraken nalopen. Nu: 0 rijen. |
| 5 | Pushen vóór de SQL | Midden | Site toont automatisch WhatsApp/telefoon als de agenda niet bereikbaar is; toch eerst SQL, dan push. Shop is onzichtbaar zonder producten. |
| 6 | Testbestellingen kunnen niet verwijderd worden (bewust) | Laag | Test met je eigen e-mail en annuleer; de bestelling blijft als "geannuleerd" staan. |
| 7 | Free plan: project pauzeert na inactiviteit; geen automatische back-ups | Midden | Export vóór migratie; later Pro of regelmatige export overwegen. |
| 8 | Supabase-publishable key staat in `config.js` (publiek) | Laag, bedoeld | Beveiliging steunt op RLS/grants (gecontroleerd); nooit de service_role-sleutel gebruiken. |
| 9 | Anon kan in de **oude** `appointments` onbeperkt boeken (oude policy) | Bestaand | Verdwijnt met stap 2. |
| 10 | Juridisch: voorwaarden/privacy noemen de shop nog niet | Midden vóór eerste verkoop | Teksten laten nakijken; geen technische blokkade. |
| 11 | Echte Supabase wijkt af van de lokale nabootsing (extensies, rolrechten van de SQL Editor) | Laag | Beide scripts gebruiken enkel standaard-Postgres; `verify.sql` en de testbestelling in stap 4 bevestigen het op het echte project. |

## 9. Verificatie na iedere stap

`supabase/verify.sql` geeft **50 rijen** (kolom `ok`: true / false / null=info). Wat je mag verwachten (zo geoefend):

| Na | Verwacht |
|---|---|
| Stap 0 (alleen oude tabellen) | 25 true, 19 false: **alle** `agenda`- en `shop`-rijen false ("ontbreekt"); alle `veiligheid`-rijen true. Info-rijen tonen de oude tabellen en policies. |
| Stap 1 (`shop.sql`) | 42 true, 8 false; false = enkel `agenda`-rijen (5 tabellen, behandelingen, beheerder) + `opslagmap promotions`. Alle `shop`-tabellen/policies/grants true. |
| Stap 1b (admin toegevoegd) | 43 true, 7 false (idem, zonder "beheerder"). |
| Stap 2 (`schema.sql`) | **50 true, 0 false.** `info: oude tabel services/appointments: aantal rijen` is gelijk aan stap 0. |

Handmatig (SQL Editor / site), telkens kort:

1. Na stap 1: `select name from storage.buckets;` toont `products`. De oude site (`eluneya-be.netlify.app`) laadt nog zoals voorheen.
2. Na stap 2: de melding "… afspraak/afspraken overgezet" klopt met je verwachting; `select count(*) from public.bookings;` idem.
3. Na stap 3 (push, op `eluneya-be.netlify.app`): `/afspraak.html` toont de agenda met vrije uren; een proefafspraak lukt en verschijnt in `/admin.html` (inloggen met Aida's account); promoties-tabblad laadt.
4. Na stap 4: `/shop/` toont de producten; kies een variant, plaats een bestelling met je eigen e-mail, controleer in admin → Shop → Bestellingen, controleer de voorraad, annuleer, controleer dat de voorraad terug is.
5. Anoniem testen (privévenster, niet ingelogd): `/admin.html` toont enkel het loginscherm; in de browserconsole levert `fetch(<project-url>/rest/v1/orders?select=*, {headers:{apikey:<publishable key>}})` een fout (401/403) en géén gegevens.

## 10. Terugdraaien (noodplan, niet uitvoeren tenzij nodig)

* **Oude site herstellen na `schema.sql`** (zet de oude toegangsregels terug; wijzigt geen rijen):
  ```sql
  create policy "Publiek kan boeken" on public.appointments for insert to anon, authenticated with check (status = 'confirmed');
  create policy "Admin volledige toegang" on public.appointments for all to authenticated using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
  ```
* **Shop verwijderen** (enkel als er nog geen bestellingen zijn die je wil bewaren; **destructief**):
  `drop table public.order_items, public.orders, public.product_variants, public.product_images, public.product_attributes, public.products, public.brands, public.product_categories;`
  `drop function public.place_order(jsonb, text, text, text, text, text, text, text, text, boolean, numeric);` (en de hulpfuncties `_product_price`, `_valid_product_attributes`, `_shop_touch`, `_orders_status_guard`) en `drop sequence public.order_number_seq;`
* De oude tabellen `services` en `appointments` worden door geen enkel script verwijderd. Opruimen van de oude site-tabellen is een latere, aparte beslissing.

## 11. Wat al getest is (alles lokaal, op wegwerpgegevens)

| Test | Resultaat |
|---|---|
| `node test/e2e/migration_rehearsal.mjs` | Beide volgordes, mét de oude tabellen en voorbeelddata: oude tabellen ongewijzigd (aantallen + checksum); oude site wel/niet werkend zoals hierboven; `verify.sql` per stap zoals in §9; 1 toekomstige oude afspraak overgezet; agenda (`book_appointment`, `get_booked_slots`), admin, shop en RLS werken; 2× herhalen verandert niets; **volgorde A en B geven dezelfde database (1017 kenmerken)**. |
| `node test/e2e/check_shop_e2e.mjs` | 73 controles over HTTP tegen echte PostgreSQL 17 + PostgREST (zelfde rollen/`auth.uid()` als Supabase): variant → bestelling → voorraad → admin → annulering; anon bereikt geen orders, klantgegevens, voorraad of beheerfuncties; prijs niet te manipuleren. Met opzettelijk gebroken RLS faalt hij op precies de verwachte punten. |
| Browser (echte site tegen de teststack) | Productpagina uit de database, variant kiezen, winkelmand, echte bestelling, admin ziet de bestelling, voorraad 5→4 en 3→1, na annulering 5 en 3. |
| `node src/check_shop_sql.mjs` (PGlite) | RLS-, validatie-, bestel- en variantentests, idempotentie. |
| `node test/e2e/audit_sql.mjs` | Geen onbeoordeelde destructieve statements (§7). |

**Niet getest:** tegen een echt Supabase-project (Auth/Storage/e-mail), het uploaden van afbeeldingen via de admin (Storage-API), de bestaande Playwright-checks (`src/check*.py`, Playwright niet geïnstalleerd), en de Netlify-rewrite voor nieuwe producten op Netlify zelf.

## 12. Openstaande beslissingen

1. Wanneer en hoe schakelt `eluneya.be` (nu SalonRound) over naar de nieuwe site? Los van dit plan.
2. Moet een test-Supabase-project (gratis, €0) aangemaakt worden om de integratietest ook tegen echte Supabase te draaien? (`test/e2e/README.md`.)
3. Voorwaarden/privacy aanpassen voor verkoop op afstand; verzendkosten en btw-weergave bevestigen.
4. E-mailmelding voor nieuwe bestellingen (nu enkel de teller in de admin).
