-- ============================================================
-- Eluneya — boekingsschema voor Supabase
-- Voer dit volledige bestand uit in: Supabase dashboard > SQL Editor > New query
-- ============================================================

-- 1. Tabel met behandelingen
create table if not exists services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric not null,
  duration_minutes int not null default 60,
  active boolean not null default true
);

insert into services (name, price, duration_minutes) values
  ('Inner balance facial', 75.00, 60),
  ('Heart harmony facial', 85.00, 75),
  ('Grounding glow facial', 105.00, 90),
  ('Iron back & mind reset', 65.00, 60),
  ('Back in control', 50.00, 45),
  ('Mind control', 40.00, 30),
  ('Intake gesprek', 0.00, 30);

-- 2. Tabel met afspraken
create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  service_name text not null,
  appointment_date date not null,
  appointment_time time not null,
  client_name text not null,
  client_email text not null,
  client_phone text,
  status text not null default 'confirmed' check (status in ('confirmed','cancelled')),
  created_at timestamptz not null default now()
);

-- 3. Voorkomt dubbele boekingen op exact hetzelfde moment
create unique index if not exists unique_confirmed_slot
  on appointments (appointment_date, appointment_time)
  where status = 'confirmed';

-- 4. Rij-niveau beveiliging: klantgegevens zijn niet publiek leesbaar
alter table appointments enable row level security;
alter table services enable row level security;

-- Iedereen mag behandelingen bekijken
create policy "Services zijn publiek leesbaar"
  on services for select
  using (active = true);

-- Iedereen mag een afspraak aanmaken (boeken)
create policy "Publiek kan boeken"
  on appointments for insert
  with check (status = 'confirmed');

-- Enkel ingelogde admin (jij) mag alle afspraken zien en beheren
create policy "Admin volledige toegang"
  on appointments for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- 5. Publieke "view" die enkel toont welke tijdstippen al bezet zijn
--    (geen naam, e-mail of telefoon zichtbaar voor bezoekers van de site)
create or replace view public_booked_slots
  with (security_invoker = false) as
  select appointment_date, appointment_time
  from appointments
  where status = 'confirmed';

grant select on public_booked_slots to anon, authenticated;

-- ============================================================
-- Klaar. Volgende stappen:
-- 1. Ga naar Authentication > Users > Add user en maak een
--    inlog aan voor jezelf (e-mail + wachtwoord) — dat is je
--    admin-login voor admin.html.
-- 2. Ga naar Project Settings > API en kopieer:
--      - Project URL
--      - anon public key
--    Plak beide in index.html en admin.html op de plek van
--    SUPABASE_URL en SUPABASE_ANON_KEY.
-- ============================================================
