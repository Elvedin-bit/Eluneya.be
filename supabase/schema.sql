-- =============================================================================
-- Eluneya — online agenda (Supabase / PostgreSQL)
--
-- Uitvoeren: Supabase-dashboard → SQL Editor → plak dit hele bestand → Run.
-- Het script is veilig om opnieuw uit te voeren (idempotent).
--
-- Ontwerp:
--   * Bezoekers (rol anon) kunnen NOOIT rechtstreeks in de tabel bookings lezen
--     of schrijven. Ze gebruiken enkel twee functies:
--       - get_booked_slots(van, tot)  → enkel bezette tijdsblokken, geen namen
--       - book_appointment(...)       → controleert alles server-side en boekt
--   * Duur en prijs komen uit de tabel treatments, nooit uit de browser.
--   * Een exclusion constraint maakt dubbele of overlappende boekingen onmogelijk,
--     ook als twee mensen op exact hetzelfde moment boeken.
--   * Aida beheert alles via admin.html (inloggen met haar Supabase-account).
--     Enkel accounts in de tabel admins hebben toegang tot klantgegevens.
--   * Vrije dagen/vakantie: via admin.html of een rij in closures.
--
-- Bestaande gegevens van de vorige versie (tabellen services/appointments):
--   * worden NIET verwijderd;
--   * toekomstige bevestigde afspraken worden eenmalig overgezet naar bookings,
--     zodat niemand op een al geboekt moment kan boeken;
--   * de te ruime oude regel "elke ingelogde gebruiker ziet alles" wordt
--     vervangen door: enkel admins.
--
-- De blokken tussen @...-start en @...-end worden automatisch ingevuld door
-- src/build.py, zodat site en database dezelfde behandelingen en uren gebruiken.
-- =============================================================================

-- ---------------------------------------------------------------- tabellen ---
create table if not exists public.treatments (
  slug          text primary key,
  name          text not null,
  duration_min  integer not null check (duration_min between 15 and 240),
  price_eur     numeric(7,2) not null check (price_eur >= 0),
  active        boolean not null default true
);

create table if not exists public.opening_hours (
  dow     smallint primary key check (dow between 0 and 6), -- 0 = zondag … 6 = zaterdag
  opens   time not null,
  closes  time not null,
  check (closes > opens)
);

create table if not exists public.closures (
  id         bigint generated always as identity primary key,
  date_from  date not null,
  date_to    date not null,
  reason     text,
  check (date_to >= date_from)
);

create table if not exists public.bookings (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  service_slug   text not null references public.treatments(slug),
  service_name   text not null,
  price_eur      numeric(7,2) not null,
  booking_date   date not null,
  start_time     time not null,
  end_time       time not null,
  blocked_until  time not null,              -- einde + buffer (opruimen/voorbereiden)
  client_name    text not null check (char_length(client_name) between 2 and 120),
  client_email   text check (client_email is null or (char_length(client_email) <= 200 and client_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  client_phone   text check (client_phone is null or char_length(client_phone) <= 40),
  notes          text check (notes is null or char_length(notes) <= 1000),
  status         text not null default 'bevestigd' check (status in ('bevestigd', 'geannuleerd')),
  constraint bookings_no_overlap exclude using gist (
    tsrange(booking_date + start_time, booking_date + blocked_until) with &&
  ) where (status = 'bevestigd')
);

create index if not exists bookings_date_idx on public.bookings (booking_date);
create index if not exists bookings_email_idx on public.bookings (lower(client_email));

-- --------------------------------------------------------- toegangsrechten ---
alter table public.treatments      enable row level security;
alter table public.opening_hours enable row level security;
alter table public.closures      enable row level security;
alter table public.bookings      enable row level security;

-- Geen policies voor anon/authenticated = geen rechtstreekse toegang.
revoke all on public.treatments, public.opening_hours, public.closures, public.bookings from anon, authenticated;

-- ------------------------------------------------------------------ gegevens ---
-- Behandelingen die niet meer in de lijst staan, worden niet meer boekbaar.
update public.treatments set active = false;
insert into public.treatments (slug, name, duration_min, price_eur) values
-- @services-start
  ('intakegesprek', 'Intakegesprek', 30, 0.00),
  ('melt-away', 'Melt Away', 60, 55.00),
  ('higher-self', 'Higher Self', 75, 75.00),
  ('go-within', 'Go Within', 90, 95.00),
  ('iron-back-mind-reset', 'Iron back & mind reset', 60, 65.00),
  ('back-in-control', 'Back in control', 45, 50.00),
  ('mind-control', 'Mind control', 30, 40.00),
  ('inner-balance-facial', 'Inner balance facial', 60, 75.00),
  ('heart-harmony-facial', 'Heart harmony facial', 75, 85.00),
  ('grounding-glow-facial', 'Grounding glow facial', 90, 105.00)
-- @services-end
on conflict (slug) do update
  set name = excluded.name, duration_min = excluded.duration_min, price_eur = excluded.price_eur, active = true;

delete from public.opening_hours;
insert into public.opening_hours (dow, opens, closes) values
-- @hours-start
  (1, '18:30', '20:30'),
  (3, '13:00', '21:00'),
  (5, '18:30', '20:30'),
  (6, '15:30', '20:30')
-- @hours-end
;

-- ------------------------------------------------------------- bezette uren ---
-- Geeft enkel tijdsblokken terug (geen persoonsgegevens). Gesloten dagen komen
-- terug als één blok van de hele dag.
create or replace function public.get_booked_slots(p_from date, p_to date)
returns table (booking_date date, start_time time, blocked_until time)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 31 then
    raise exception 'ongeldige_periode';
  end if;

  return query
    select b.booking_date, b.start_time, b.blocked_until
      from public.bookings b
     where b.status = 'bevestigd'
       and b.booking_date between p_from and p_to
    union all
    select d::date, time '00:00', time '23:59:59'
      from public.closures c,
           generate_series(greatest(c.date_from, p_from), least(c.date_to, p_to), interval '1 day') d
     where c.date_to >= p_from and c.date_from <= p_to;
end;
$$;

-- ------------------------------------------------------------------ boeken ---
create or replace function public.book_appointment(
  p_service text,
  p_date    date,
  p_start   time,
  p_name    text,
  p_email   text,
  p_phone   text default null,
  p_notes   text default null
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  buffer_minutes     integer;
  min_notice_hours   integer;
  max_days_ahead     integer;
  max_open_per_email integer;
  slot_step          integer;
  v_now      timestamp := (now() at time zone 'Europe/Brussels');
  v_service  public.treatments%rowtype;
  v_hours    public.opening_hours%rowtype;
  v_end      time;
  v_open_cnt integer;
  v_id       uuid;
begin
  -- @settings-start
  buffer_minutes := 15;
  min_notice_hours := 3;
  max_days_ahead := 56;
  max_open_per_email := 3;
  slot_step := 30;
  -- @settings-end

  select * into v_service from public.treatments where slug = p_service and active;
  if not found then raise exception 'onbekende_behandeling'; end if;

  if p_date is null or p_start is null then raise exception 'ongeldige_gegevens'; end if;
  if p_date + p_start < v_now + make_interval(hours => min_notice_hours) then raise exception 'te_kort_op_voorhand'; end if;
  if p_date > (v_now::date + max_days_ahead) then raise exception 'te_ver_vooruit'; end if;
  if extract(second from p_start) <> 0 or (extract(hour from p_start) * 60 + extract(minute from p_start))::int % slot_step <> 0 then
    raise exception 'ongeldig_tijdslot';
  end if;

  select * into v_hours from public.opening_hours where dow = extract(dow from p_date)::smallint;
  if not found then raise exception 'buiten_openingsuren'; end if;

  v_end := p_start + make_interval(mins => v_service.duration_min);
  if p_start < v_hours.opens or v_end > v_hours.closes or v_end <= p_start then
    raise exception 'buiten_openingsuren';
  end if;

  if exists (select 1 from public.closures c where p_date between c.date_from and c.date_to) then
    raise exception 'gesloten';
  end if;

  p_name  := nullif(btrim(p_name), '');
  p_email := lower(nullif(btrim(p_email), ''));
  p_phone := nullif(btrim(coalesce(p_phone, '')), '');
  p_notes := nullif(btrim(coalesce(p_notes, '')), '');
  if p_name is null or p_email is null then raise exception 'ongeldige_gegevens'; end if;

  select count(*) into v_open_cnt
    from public.bookings b
   where lower(b.client_email) = p_email
     and b.status = 'bevestigd'
     and b.booking_date >= v_now::date;
  if v_open_cnt >= max_open_per_email then raise exception 'te_veel_boekingen'; end if;

  begin
    insert into public.bookings (service_slug, service_name, price_eur, booking_date, start_time, end_time, blocked_until,
                                 client_name, client_email, client_phone, notes)
    values (v_service.slug, v_service.name, v_service.price_eur, p_date, p_start, v_end,
            case when v_end + make_interval(mins => buffer_minutes) < v_end then time '23:59:59'
                 else v_end + make_interval(mins => buffer_minutes) end,
            p_name, p_email, p_phone, p_notes)
    returning id into v_id;
  exception
    when exclusion_violation then raise exception 'tijdslot_bezet';
    when check_violation     then raise exception 'ongeldige_gegevens';
  end;

  return json_build_object(
    'id', v_id,
    'service', v_service.name,
    'date', p_date,
    'start', to_char(p_start, 'HH24:MI'),
    'end', to_char(v_end, 'HH24:MI')
  );
end;
$$;

-- Enkel deze twee functies zijn publiek aanroepbaar.
revoke all on function public.get_booked_slots(date, date) from public;
revoke all on function public.book_appointment(text, date, time, text, text, text, text) from public;
grant execute on function public.get_booked_slots(date, date) to anon, authenticated;
grant execute on function public.book_appointment(text, date, time, text, text, text, text) to anon, authenticated;

-- ================================================================ beheer ===
-- Enkel wie in admins staat, ziet en beheert afspraken via admin.html.
-- Aida toevoegen (eenmalig, na het aanmaken van haar account onder
-- Authentication → Users):
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'HAAR-EMAIL@VOORBEELD.BE'
--   on conflict do nothing;
create table if not exists public.admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Afspraken: lezen, toevoegen (bv. telefonische boeking) en annuleren. Nooit verwijderen.
grant select, insert, update on public.bookings to authenticated;
drop policy if exists "admin leest afspraken" on public.bookings;
drop policy if exists "admin voegt afspraken toe" on public.bookings;
drop policy if exists "admin wijzigt afspraken" on public.bookings;
create policy "admin leest afspraken"      on public.bookings for select to authenticated using (public.is_admin());
create policy "admin voegt afspraken toe"  on public.bookings for insert to authenticated with check (public.is_admin());
create policy "admin wijzigt afspraken"    on public.bookings for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Vrije dagen beheren
grant select, insert, delete on public.closures to authenticated;
drop policy if exists "admin beheert sluitingsdagen" on public.closures;
create policy "admin beheert sluitingsdagen" on public.closures for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Behandelingen en openingsuren lezen (voor de agenda in admin.html)
grant select on public.treatments, public.opening_hours to authenticated;
drop policy if exists "admin leest behandelingen" on public.treatments;
drop policy if exists "admin leest openingsuren" on public.opening_hours;
create policy "admin leest behandelingen" on public.treatments    for select to authenticated using (public.is_admin());
create policy "admin leest openingsuren"  on public.opening_hours for select to authenticated using (public.is_admin());

-- ===================================================== vorige versie (eenmalig) ===
do $$
declare
  r       record;
  v_tr    public.treatments%rowtype;
  v_end   time;
  v_count integer := 0;
begin
  if to_regclass('public.appointments') is null then
    return;
  end if;

  -- 1. Oude, te ruime toegangsregel vervangen door "enkel admins".
  execute 'drop policy if exists "Admin volledige toegang" on public.appointments';
  execute 'drop policy if exists "admin oude afspraken" on public.appointments';
  execute 'create policy "admin oude afspraken" on public.appointments for all to authenticated using (public.is_admin()) with check (public.is_admin())';
  -- Online boeken loopt voortaan via book_appointment(); de oude open insert-regel mag weg.
  execute 'drop policy if exists "Publiek kan boeken" on public.appointments';

  -- 2. Toekomstige bevestigde afspraken overzetten (wordt maar één keer gedaan per afspraak).
  for r in execute $q$
    select a.id, a.service_name, a.appointment_date, a.appointment_time, a.client_name, a.client_email, a.client_phone
      from public.appointments a
     where a.status = 'confirmed'
       and a.appointment_date >= (now() at time zone 'Europe/Brussels')::date
  $q$ loop
    if exists (select 1 from public.bookings b where b.notes = 'Overgezet uit vorige agenda (' || r.id || ')') then
      continue;
    end if;
    select * into v_tr from public.treatments t
     where lower(t.name) = lower(r.service_name)
        or (lower(r.service_name) = 'intake gesprek' and t.slug = 'intakegesprek')
     limit 1;
    if not found then
      select * into v_tr from public.treatments t where t.slug = 'intakegesprek';
    end if;
    v_end := r.appointment_time + make_interval(mins => v_tr.duration_min);
    begin
      insert into public.bookings (service_slug, service_name, price_eur, booking_date, start_time, end_time, blocked_until,
                                   client_name, client_email, client_phone, notes)
      values (v_tr.slug, r.service_name, v_tr.price_eur, r.appointment_date, r.appointment_time, v_end, v_end,
              case when char_length(btrim(r.client_name)) >= 2 then left(btrim(r.client_name), 120) else 'Onbekend' end,
              case when r.client_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then r.client_email end,
              left(r.client_phone, 40),
              'Overgezet uit vorige agenda (' || r.id || ')');
      v_count := v_count + 1;
    exception when exclusion_violation or check_violation then
      raise notice 'Niet overgezet (overlap of ongeldige gegevens): % % %', r.appointment_date, r.appointment_time, r.client_name;
    end;
  end loop;
  raise notice '% afspraak/afspraken overgezet uit de vorige agenda.', v_count;
end;
$$;
