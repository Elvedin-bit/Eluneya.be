# Eigen boekingssysteem — opzetgids

Je site praat nu met een gratis Supabase-database in plaats van met Salonround.
Geen server om te beheren — Supabase host alles voor je.

## Stap 1 — Supabase-account en project
1. Ga naar https://supabase.com en maak een gratis account.
2. Klik **New project**. Kies een naam (bv. "eluneya") en een wachtwoord voor de database
   (bewaar dit ergens veilig, je hebt het zelden nodig).
3. Wacht tot het project klaar is (ongeveer 1-2 minuten).

## Stap 2 — Database aanmaken
1. Ga in het Supabase-dashboard naar **SQL Editor** > **New query**.
2. Open `supabase-schema.sql` (bijgevoegd), kopieer de volledige inhoud, plak het in de
   query-editor en klik **Run**.
3. Dit maakt de tabellen `services` en `appointments` aan, plus de regels die
   dubbele boekingen tegenhouden en klantgegevens privé houden.

## Stap 3 — Jouw eigen inlog aanmaken
1. Ga naar **Authentication** > **Users** > **Add user**.
2. Vul je eigen e-mailadres en een wachtwoord in. Dit is je login voor `admin.html`.

## Stap 4 — Sleutels ophalen en invullen
1. Ga naar **Project Settings** (tandwiel-icoon) > **API**.
2. Kopieer de **Project URL** en de **anon public key**.
3. Open zowel `index.html` als `admin.html` in VS Code, zoek naar:
   ```js
   const SUPABASE_URL = 'JOUW_SUPABASE_URL';
   const SUPABASE_ANON_KEY = 'JOUW_SUPABASE_ANON_KEY';
   ```
4. Vervang beide waarden door je eigen Project URL en anon key, in **beide bestanden**.

## Stap 5 — Testen
1. Open `index.html` (bv. met de Live Server-extensie in VS Code).
2. Klik op "Maak afspraak", vul een naam en e-mail in, kies een datum/uur en bevestig.
3. Open `admin.html`, log in met het account uit stap 3 — de afspraak moet daar verschijnen.
4. Probeer hetzelfde tijdstip nog eens te boeken: je krijgt nu een melding dat het al bezet is.

## Wat dit systeem wel en niet doet
**Wel:**
- Voorkomt dubbele boekingen op exact hetzelfde tijdstip
- Toont bezette uren als niet-klikbaar in de boekingsagenda
- Houdt klantgegevens (naam, e-mail, telefoon) privé — enkel jij ziet die via `admin.html`
- Laat je afspraken annuleren via `admin.html`

**Nog niet inbegrepen (kan ik later toevoegen als je wil):**
- Automatische bevestigingsmail naar de klant (kan via bv. Resend of EmailJS)
- Herinneringsmails vóór de afspraak
- Synchronisatie met Google Agenda
- Meerdere behandelaars/kamers tegelijk (nu is er telkens maar 1 afspraak per tijdstip mogelijk)
- Betaling of aanbetaling bij het boeken

## Gratis tot welke grens?
Supabase's gratis tier is ruim voldoende voor een salon: tot 500MB database en
50.000 actieve gebruikers per maand. Voor een lokale zaak kom je daar niet snel aan.
