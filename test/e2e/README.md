# Testopstelling voor de webshop en de migratie

Alles hier draait **lokaal op wegwerpgegevens** en raakt nooit de productie-Supabase.

| Wat | Hoe |
|---|---|
| Teststack: echte PostgreSQL 17 (embedded-postgres) + echte PostgREST + proxy (`/rest/v1`, CORS) met Supabase-achtige rollen en `auth.uid()` | `node stack.mjs [--mode=prod-sim\|fresh\|shop-only]` |
| Demo-assortiment in de teststack (via de REST-API als admin) | `node seed_demo.mjs` |
| Integratietest over HTTP: product → variant → bestelling → voorraad → admin → annulering, RLS en prijsmanipulatie | `node check_shop_e2e.mjs` |
| Oefening van de productiemigratie op wegwerpdatabases (beide volgordes, mét oude tabellen en data) | `node migration_rehearsal.mjs` (`REHEARSAL_VERBOSE=1` toont elke afwijking) |
| Statische audit op destructieve SQL | `node audit_sql.mjs` |
| SQL- en RLS-tests in PGlite (sneller, zonder PostgREST) | `PGLITE_DIR=… node ../../src/check_shop_sql.mjs` |

## Eenmalig

```
cd test/e2e
npm install                  # embedded-postgres (Postgres 17) en pg
node fetch-postgrest.mjs     # officiële PostgREST v16.4 van GitHub (~15 MB, checksum wordt gecontroleerd) → .bin/
```

Op Windows heeft `postgrest.exe` `libpq.dll` nodig; `stack.mjs` zet daarvoor de map van embedded-postgres op het PATH.

## De volledige flow tegen de teststack

```
node stack.mjs                 # laat dit venster open; schrijft .data/env.json
node seed_demo.mjs             # (andere terminal) demo-parfums met varianten
node check_shop_e2e.mjs        # 70+ controles over HTTP
```

Daarna kan de echte website ertegen draaien:

```
ELUNEYA_SUPABASE_URL=http://127.0.0.1:3100 ELUNEYA_SUPABASE_KEY=<anonKey uit .data/env.json> \
ELUNEYA_OUT=<testmap> ELUNEYA_CATALOG=<testmap>/catalog.json python3 src/build.py --fetch-catalog
```

en zet in `<testmap>/assets/js/config.js` `supabaseUrl: 'http://127.0.0.1:3100'` met dezelfde sleutel. Een testsessie voor
`admin.html` is een JWT uit `.data/env.json` (`adminJwt`) in `localStorage['sb-127-auth-token']`. De winkelmand accepteert voor
`http://` enkel `localhost`/`127.0.0.1`.

## Tegen een aparte test-Supabase (optioneel, later)

`check_shop_e2e.mjs` draait ook tegen een **apart testproject**, nooit tegen productie:

```
E2E_REST_URL=https://<TESTREF>.supabase.co/rest/v1  E2E_TEST_PROJECT_REF=<TESTREF> \
E2E_ANON_KEY=<publishable key>  E2E_ADMIN_JWT=<JWT van een testadmin>  E2E_USER_JWT=<JWT van een gewone testgebruiker> \
node check_shop_e2e.mjs
```

(Of `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` en `E2E_AUTH_URL=https://<TESTREF>.supabase.co/auth/v1`.) Het script weigert het
productieproject (`jdfcheqimbxffxldedey` of de URL uit `site/assets/js/config.js`) en elk extern adres zonder `E2E_TEST_PROJECT_REF`.
Testproject: eerst `schema.sql` en `shop.sql` uitvoeren en een admin toevoegen (zie `docs/PRODUCTIE-PLAN.md`).

## Wat de tests bewijzen

* `check_shop_e2e.mjs`: de exacte select van de website (met embeds) werkt voor anon; anon kan orders, order_items, admins,
  voorraad (`stock_qty`, `track_stock`, variantvoorraad) en klantgegevens niet lezen, nergens schrijven, geen beheerfuncties
  uitvoeren en geen prijs meesturen; een gewone ingelogde gebruiker is geen admin; de admin kan bestellingen beheren maar niet
  achteraf bedragen of klantgegevens wijzigen of een bestelling verwijderen; annuleren zet de variantvoorraad terug.
  Controle van de test zelf: met opzettelijk gebroken RLS faalt hij op precies die punten.
* `migration_rehearsal.mjs`: zie `docs/PRODUCTIE-PLAN.md` (resultaten per stap).
