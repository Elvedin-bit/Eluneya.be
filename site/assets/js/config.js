/* =============================================================================
   Eluneya — instellingen van de online agenda
   -----------------------------------------------------------------------------
   Vul hier de gegevens van het Supabase-project in:
   Supabase-dashboard → Project Settings → API (of "API Keys").

   - url: de Project URL, bv. https://abcdefgh.supabase.co
   - key: de PUBLISHABLE key (begint met sb_publishable_) of de oude "anon public" key.
          Deze sleutel mag publiek zijn: de database laat bezoekers enkel de twee
          boekingsfuncties gebruiken (zie supabase/schema.sql).
          Gebruik hier NOOIT de secret/service_role key.

   Laat je url of key leeg, dan toont de afsprakenpagina automatisch WhatsApp
   en telefoon als alternatief.
   ========================================================================== */
window.ELUNEYA_CONFIG = {
  // CONTROLEREN: overgenomen uit de vorige versie van de site. Voer eerst supabase/schema.sql uit in dit project.
  supabaseUrl: 'https://jdfcheqimbxffxldedey.supabase.co',
  supabaseKey: 'sb_publishable_CgzLJMXvMZmC_x7K7wEj5w_tX7SVtNI'
};
