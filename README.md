# Eluneya — website

Statische website (HTML/CSS/JS, geen framework) met een eigen online agenda op Supabase.

## Mappen

```
site/                 ← dit is de website: deze map upload je naar de hosting
  *.html              9 pagina's (home, behandelingen, journeys, over, contact, afspraak, privacy, voorwaarden, 404)
  assets/css/         style.css
  assets/js/          main.js (menu, animaties) · booking.js (agenda) · promotions.js (popup + banner) · config.js (Supabase-sleutels) · services.js (gegenereerd)
  assets/img/         foto's als WebP, twee formaten per foto
  assets/fonts/       Cormorant Garamond + Poppins, lokaal (geen Google Fonts)
  favicon, iconen, og-image.jpg, site.webmanifest, robots.txt, sitemap.xml
site/admin.html     beheerpagina voor Aida (wordt niet door build.py aangemaakt)
src/
  build.py            bouwt site/ opnieuw op (gegevens, prijzen, openingsuren op één plek)
  pages/              de inhoud van elke pagina
  check.py, check_booking.py, check_promotions*.py   automatische controles (optioneel, vereisen Playwright; check_promotions_sql.py een wegwerp-PostgreSQL)
supabase/
  schema.sql          database voor de agenda (eenmalig uitvoeren)
  shop.sql            database voor de webshop (apart, idempotent; zie "Webshop")
  functions/booking-notify/index.ts   optionele e-mailmelding bij een nieuwe afspraak
```

## Iets aanpassen

Prijzen, behandelingen, openingsuren, telefoon, adres …: pas ze aan bovenaan `src/build.py` en voer uit:

```
python3 src/build.py
```

Dat werkt alle pagina's, `services.js` (agenda) **en** `supabase/schema.sql` tegelijk bij.
Voer daarna `schema.sql` opnieuw uit in Supabase, zodat de agenda dezelfde duur en uren gebruikt.

Teksten van een pagina pas je aan in `src/pages/<pagina>.html` en daarna opnieuw `python3 src/build.py`.
(De bestanden in `site/` mag je ook rechtstreeks aanpassen, maar die worden overschreven bij een volgende build.)

## Agenda instellen (eenmalig)

1. Supabase-dashboard → **SQL Editor** → plak `supabase/schema.sql` → **Run**.
   Toekomstige afspraken uit de vorige agenda worden automatisch overgezet.
2. Aida beheerrechten geven (eenmalig, SQL Editor, met haar login-e-mailadres uit Authentication → Users):
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'HAAR-EMAIL' on conflict do nothing;
   ```
3. Aida beheert alles via **/admin.html**: weekoverzicht, lijst, details, annuleren,
   telefonische afspraken toevoegen en vrije dagen blokkeren.
4. Zet onder Authentication → Sign In / Providers **"Allow new users to sign up" uit**:
   enkel Aida heeft een account nodig.
5. Optioneel: e-mailmelding voor Aida via `supabase/functions/booking-notify` (stappen staan bovenaan dat bestand).
   Zonder deze stap komen afspraken wel binnen, maar krijgt Aida geen melding.

Is de agenda niet gekoppeld of onbereikbaar, dan toont de afsprakenpagina automatisch WhatsApp en telefoon.

## Promoties en popups

Aida beheert ze zelf in **/admin.html → tabblad Promoties**: toevoegen, bewerken, activeren/uitschakelen, verwijderen.

- **Automatisch aan/uit:** een promotie is zichtbaar van de startdatum tot en met de einddatum (Belgische tijd), en alleen als ze *Actief* staat.
- **Popup** (met vertraging in seconden, na het sluiten pas na 7 dagen opnieuw) en/of **banner** bovenaan elke pagina (na sluiten niet meer tijdens dat bezoek). De popup verschijnt niet op de afsprakenpagina.
- **Korting:** percentage (1–50 %) of vast bedrag (€ 1–100), voor één behandeling of alle behandelingen. Zonder promotiecode geldt de korting automatisch; met code enkel voor wie de code invult (de code is niet publiek leesbaar, zet hem in de beschrijving als iedereen hem mag zien). Meerdere promoties worden nooit gecombineerd: de grootste korting wint. Een klant (e-mailadres) kan dezelfde promotie maar één keer gebruiken, tenzij de afspraak geannuleerd wordt.
- **Prijzen:** de prijs in `treatments` verandert nooit. De server (`get_price_quote` en `book_appointment`) berekent de korting; `bookings` bewaart de betaalde prijs (`price_eur`), de normale prijs (`list_price_eur`), de korting (`discount_eur`) en een momentopname van de promotie. Een bestaande afspraak behoudt dus altijd haar prijs, ook als de promotie later wijzigt of verdwijnt.
- **Afbeeldingen** komen in de openbare opslagmap `promotions` (enkel admins kunnen uploaden). Maak ze 16:9, JPG/PNG/WebP, max. 2 MB.
- Na een update van `schema.sql` is er niets extra nodig: voer het bestand opnieuw uit.

## Webshop (parfums en meer)

Eén geïntegreerde shop in dezelfde site: `/shop/`, `/shop/<categorie>/` en `/shop/<categorie>/<product>/`, een winkelmand
(`winkelmand.html`, bewaard in de browser) en een **bestelaanvraag** (geen online betaling: Aida bevestigt en spreekt betaling
en levering af, bv. via WhatsApp). Parfums zijn de eerste categorie; Beauty, Wellness, Workshops, E-books en eigen categorieën
gebruiken dezelfde structuur.

**Zolang `src/catalog.json` geen producten bevat, is de shop onzichtbaar**: geen menu-item, geen winkelmandicoon, geen pagina's in
de sitemap. De bestaande site wordt dan byte voor byte identiek gebouwd.

### Opbouw

| Onderdeel | Bestand |
|---|---|
| Database (tabellen, RLS, `place_order`) | `supabase/shop.sql` (apart van `schema.sql`) |
| Demogegevens voor een testomgeving — **niet voor productie** | `supabase/shop_demo.sql`, `src/catalog.demo.json` |
| Pagina's, menu, SEO, catalogus-momentopname | `src/shop.py` (aangeroepen door `build.py`), `src/pages/winkelmand.html` |
| Winkelmand (localStorage) en gedeelde functies | `site/assets/js/cart.js` |
| Overzicht, filters, zoeken · productpagina · afrekenen | `shop.js` · `product.js` · `checkout.js` |
| Stijl | `site/assets/css/shop.css` (+ kleine aanvulling in `style.css` voor menu/winkelmandicoon) |
| Beheer (tabblad **Shop** in `admin.html`) | `site/assets/js/admin-shop.js` |
| Tests van de database | `src/check_shop_sql.mjs` (lokale wegwerp-Postgres via PGlite) |
| Integratietests tegen echte PostgreSQL + PostgREST, migratie-oefening, SQL-audit | `test/e2e/` (zie `test/e2e/README.md`) |
| Controle na een migratie (alleen lezen) | `supabase/verify.sql` |
| Plan voor de migratie naar productie | `docs/PRODUCTIE-PLAN.md` |
| Controle van de gebouwde site (links, afbeeldingen, metadata, JSON-LD, sitemap, geheimen, plaatshouders) | `node test/site_check.mjs` |
| Controle van de productie-API als bezoeker (enkel alleen-lezen en af te wijzen aanvragen) | `node test/prod_check.mjs` |
| Controle van een gepubliceerde site (live = lokaal, headers, routes) | `node test/live_check.mjs https://eluneya-be.netlify.app` |
| Voorbeeldbestand van de hele site (ook shop) om door te sturen | `python3 src/preview.py` → `voorbeeld/eluneya-voorbeeld.html` (zie `src/preview.py`) |

Datamodel: `product_categories` (met `attribute_set`, bv. `fragrance` voor geurprofiel; `parent_id` voor subcategorieën),
`brands`, `products`, `product_attributes` (jsonb: geurfamilie, concentratie, top-/hart-/basisnoten, later andere velden),
`product_images`, `product_variants`, `orders` en `order_items`.

**Varianten (formaten):** Aida bepaalt per product zelf welke varianten er zijn (bv. enkel 15 ml en 70 ml; er zijn geen vaste
formaten). Elke variant heeft een naam, inhoud (ml), productcode (SKU), eigen prijs (leeg = productprijs, en dan geldt ook de
actieprijs van het product), eigen voorraad (leeg = niet bijgehouden) en een actief/inactief-schakelaar. Heeft een product
varianten, dan is een gekozen variant verplicht; de voorraad zit per variant; het product is uitverkocht als geen enkele variant
nog beschikbaar is. De gekozen variant gaat mee naar winkelmand, `place_order`, `order_items` (id, naam, SKU, prijs) en wordt bij
annulering teruggeboekt op de plek waar ze afgeboekt werd (`order_items.stock_effect`).
Betaling zit bewust los van de bestelling (`payment_status`, `payment_provider`, `payment_reference`): een betaalprovider
(Mollie, …) kan later toegevoegd worden zonder tabellen te herschrijven.

### Beveiliging (RLS)

- Bezoekers (anon) lezen enkel **actieve** producten in **actieve** categorieën, en enkel publieke kolommen. De voorraad
  (`stock_qty`, `track_stock`) is niet leesbaar; `is_available` geeft enkel aan of iets bestelbaar is.
- Bezoekers kunnen niet rechtstreeks in `orders`/`order_items` lezen of schrijven. Bestellen gaat enkel via `place_order()`:
  prijzen, actieprijzen (met datums), voorraad en totaal worden server-side berekend; de browser kan geen prijs doorgeven.
  Max. 3 openstaande aanvragen per e-mailadres, max. 10 stuks per product, honeypot-veld in het formulier.
- Enkel accounts in `admins` beheren producten/categorieën/voorraad en lezen bestellingen. Admins kunnen van een bestelling enkel
  status, betaalstatus en notities wijzigen (geen bedragen of klantgegevens), nooit verwijderen. Annuleren zet de voorraad terug.
- Controle: `PGLITE_DIR=<map met node_modules/@electric-sql/pglite> node src/check_shop_sql.mjs`
  (eenmalig: `npm i @electric-sql/pglite` in een lege map). Draait nooit tegen een echte database.

### Producten beheren (Aida)

`/admin.html` → tabblad **Shop**: *Bestellingen* (status, betaling, WhatsApp/e-mail naar de klant), *Producten* (prijs,
promotieprijs met optionele datums, foto's, parfumvelden, voorraad, actief/uitgelicht), *Categorieën*, *Voorraad*.
Een nieuw product is eerst niet zichtbaar tot je het activeert. Zodra het actief is, staat het meteen in de shop en kan het besteld
worden (de generieke pagina `shop/product.html` haalt het live op). De vaste, door Google indexeerbare productpagina ontstaat bij de
volgende publicatie (zie hieronder).

### Vaste productpagina's publiceren

```
python3 src/build.py --fetch-catalog   # haalt de actieve catalogus op (enkel leesrechten) en bewaart src/catalog.json
git add -A && git commit -m "Catalogus bijgewerkt" && git push
```

Prijzen en voorraad op de pagina's worden bij het openen live vernieuwd; enkel nieuwe producten/teksten/foto's hebben een publicatie nodig.
`netlify.toml` bevat de rewrite voor producten zonder vaste pagina.

### Wat er nodig is om de shop op productie te zetten (nog NIET gedaan)

Er is bewust niets op de productiedatabase uitgevoerd. Volgorde:

1. **`supabase/shop.sql`** uitvoeren in Supabase → SQL Editor. Idempotent en zelfstandig: het maakt zelf `admins` en `is_admin()`
   aan als ze nog niet bestaan (identiek aan `schema.sql`), de tabellen, RLS, `place_order`, de openbare opslagmap `products` en de
   zes basiscategorieën.
   *(Let op: de live database bevatte bij de laatste controle nog niet de agenda uit `schema.sql` (`treatments`, `bookings`,
   `promotions`). Voor de afsprakenmodule is `schema.sql` nog steeds nodig; de volgorde van beide scripts maakt niet uit.)*
2. Aida beheerrechten geven (zoals bij de agenda), met haar login-e-mailadres:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'HAAR-EMAIL' on conflict do nothing;
   ```
3. Controleer onder Authentication dat "Allow new users to sign up" **uit** staat.
4. Eerste producten toevoegen via `/admin.html` → Shop, daarna `python3 src/build.py --fetch-catalog` en pushen.
   Pas dan verschijnt Shop in het menu.
5. Niet uitvoeren op productie: `supabase/shop_demo.sql` (verzonnen producten).

### Nog te beslissen voor de lancering (niet technisch)

- **Algemene voorwaarden en privacyverklaring** vermelden de webshop nog niet (herroepingsrecht bij verkoop op afstand, levering,
  bewaartermijn van bestelgegevens). Laat die teksten nakijken vóór de eerste verkoop.
- **Btw en verzendkosten**: prijzen worden als "inclusief btw" getoond; verzendkosten zijn nu "in overleg".
- **E-mailmelding voor nieuwe bestellingen** bestaat nog niet (Aida ziet ze in de admin; het tabblad toont het aantal nieuwe).
  `supabase/functions/booking-notify` kan als voorbeeld dienen.
- **Online betaling**: later via een betaalprovider; `orders.payment_*` staat klaar.

## Online zetten

Deze map staat in GitHub (Elvedin-bit/Eluneya.be) en is gekoppeld aan het Netlify-project
**eluneya-be**. `netlify.toml` zegt Netlify dat de map `site/` gepubliceerd moet worden.
Elke push naar `main` zet de nieuwe versie automatisch online.

Andere hosting kan ook:

Upload de inhoud van `site/` naar eender welke statische hosting (Netlify, Cloudflare Pages, Vercel, combell, …).
Netlify: sleep de map `site` naar app.netlify.com/drop. `404.html` wordt daar automatisch gebruikt.

Daarna: het definitieve domein invullen in `src/build.py` (`domain`), opnieuw bouwen, en de sitemap
indienen in Google Search Console.
