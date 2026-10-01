# Eluneya — website

Statische website (HTML/CSS/JS, geen framework) met een eigen online agenda op Supabase.

## Mappen

```
site/                 ← dit is de website: deze map upload je naar de hosting
  *.html              9 pagina's (home, behandelingen, journeys, over, contact, afspraak, privacy, voorwaarden, 404)
  assets/css/         style.css
  assets/js/          main.js (menu, animaties) · booking.js (agenda) · config.js (Supabase-sleutels) · services.js (gegenereerd)
  assets/img/         foto's als WebP, twee formaten per foto
  assets/fonts/       Cormorant Garamond + Poppins, lokaal (geen Google Fonts)
  favicon, iconen, og-image.jpg, site.webmanifest, robots.txt, sitemap.xml
site/admin.html     beheerpagina voor Aida (wordt niet door build.py aangemaakt)
src/
  build.py            bouwt site/ opnieuw op (gegevens, prijzen, openingsuren op één plek)
  pages/              de inhoud van elke pagina
  check.py, check_booking.py   automatische controles (optioneel, vereisen Playwright)
supabase/
  schema.sql          database voor de agenda (eenmalig uitvoeren)
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

## Online zetten

Deze map staat in GitHub (Elvedin-bit/Eluneya.be) en is gekoppeld aan het Netlify-project
**eluneya-be**. `netlify.toml` zegt Netlify dat de map `site/` gepubliceerd moet worden.
Elke push naar `main` zet de nieuwe versie automatisch online.

Andere hosting kan ook:

Upload de inhoud van `site/` naar eender welke statische hosting (Netlify, Cloudflare Pages, Vercel, combell, …).
Netlify: sleep de map `site` naar app.netlify.com/drop. `404.html` wordt daar automatisch gebruikt.

Daarna: het definitieve domein invullen in `src/build.py` (`domain`), opnieuw bouwen, en de sitemap
indienen in Google Search Console.
