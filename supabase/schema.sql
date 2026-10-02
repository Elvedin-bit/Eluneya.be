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
--   * Promoties (tabel promotions, beheerd via admin.html): bezoekers lezen enkel lopende
--     promoties; de korting wordt server-side berekend en per boeking bewaard.
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

-- ------------------------------------------------------------------ promoties ---
-- Aida beheert promoties via admin.html (tabblad Promoties).
--   * service_slug verwijst naar treatments(slug); leeg = geldt voor alle behandelingen.
--   * promo_code leeg   = korting wordt automatisch toegepast;
--     promo_code ingevuld = enkel met die code (de code zelf is NIET publiek leesbaar).
--   * start_date/end_date zijn kalenderdagen (Belgische tijd), beide inclusief:
--     een promotie van 1 t/m 31 december verschijnt op 1/12 en verdwijnt na 31/12.
--   * Limieten tegen extreme kortingen: percentage 1–50 %, vast bedrag € 1–100.
create table if not exists public.promotions (
  id             uuid primary key default gen_random_uuid(),
  title          text not null check (char_length(btrim(title)) between 2 and 80),
  description    text check (description is null or char_length(description) <= 400),
  image_url      text check (image_url is null or (char_length(image_url) <= 500 and image_url ~ '^https://[^\s]+$')),
  discount_type  text not null check (discount_type in ('percentage', 'fixed')),
  discount_value numeric(7,2) not null,
  promo_code     text check (promo_code is null or promo_code ~ '^[A-Z0-9_-]{3,20}$'),
  service_slug   text references public.treatments(slug) on delete cascade,
  start_date     date not null,
  end_date       date not null,
  is_active      boolean not null default true,
  show_popup     boolean not null default true,
  show_banner    boolean not null default false,
  popup_delay    integer not null default 5 check (popup_delay between 0 and 120),
  button_text    text not null default 'Boek nu' check (char_length(btrim(button_text)) between 1 and 40),
  priority       integer not null default 0 check (priority between 0 and 100),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  requires_code  boolean generated always as (promo_code is not null) stored,
  constraint promotions_dates_ok check (end_date >= start_date),
  constraint promotions_discount_ok check (
    (discount_type = 'percentage' and discount_value >= 1 and discount_value <= 50) or
    (discount_type = 'fixed'      and discount_value >= 1 and discount_value <= 100)
  )
);
create unique index if not exists promotions_code_uidx on public.promotions (promo_code) where promo_code is not null;
create index if not exists promotions_period_idx on public.promotions (start_date, end_date) where is_active;

-- Code netjes opslaan (hoofdletters), updated_at bijhouden en een vaste korting
-- nooit hoger laten zijn dan de prijs van de gekoppelde behandeling.
create or replace function public.promotions_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_price numeric;
begin
  new.title       := btrim(new.title);
  new.button_text := btrim(new.button_text);
  new.description := nullif(btrim(coalesce(new.description, '')), '');
  new.promo_code  := upper(nullif(btrim(coalesce(new.promo_code, '')), ''));
  new.updated_at  := now();
  if new.discount_type = 'fixed' and new.service_slug is not null then
    select price_eur into v_price from public.treatments where slug = new.service_slug;
    if v_price is not null and new.discount_value > v_price then
      raise exception 'korting_hoger_dan_prijs' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists promotions_before_write on public.promotions;
create trigger promotions_before_write before insert or update on public.promotions
  for each row execute function public.promotions_before_write();

-- Boekingen bewaren hun eigen prijs. price_eur blijft de prijs die de klant effectief
-- betaalt (zoals voorheen); de normale prijs en de korting staan er apart naast.
-- Oude boekingen hebben geen korting: list_price_eur = price_eur, discount_eur = 0.
alter table public.bookings add column if not exists list_price_eur   numeric(7,2);
alter table public.bookings add column if not exists discount_eur     numeric(7,2) not null default 0 check (discount_eur >= 0);
alter table public.bookings add column if not exists promotion_id     uuid references public.promotions(id) on delete set null;
alter table public.bookings add column if not exists promotion_title  text;   -- momentopname, blijft bestaan als de promotie wordt verwijderd
alter table public.bookings add column if not exists promo_code       text;
update public.bookings set list_price_eur = price_eur where list_price_eur is null;

-- Eén promotie per e-mailadres (zolang de afspraak niet geannuleerd is):
-- voorkomt dat een code of actie meermaals door dezelfde klant gebruikt wordt, ook bij gelijktijdig boeken.
create unique index if not exists bookings_promo_once_uidx
  on public.bookings (promotion_id, lower(client_email))
  where promotion_id is not null and status = 'bevestigd' and client_email is not null;

-- --------------------------------------------------------- toegangsrechten ---
alter table public.treatments      enable row level security;
alter table public.opening_hours enable row level security;
alter table public.closures      enable row level security;
alter table public.bookings      enable row level security;

-- Geen policies voor anon/authenticated = geen rechtstreekse toegang.
revoke all on public.treatments, public.opening_hours, public.closures, public.bookings from anon, authenticated;

-- Promoties: bezoekers (anon) mogen enkel lopende promoties lezen, en enkel de kolommen
-- die publiek nodig zijn. De promocode zelf (promo_code) is bewust niet leesbaar.
alter table public.promotions enable row level security;
revoke all on public.promotions from anon, authenticated;
grant select (id, title, description, image_url, discount_type, discount_value, service_slug, start_date, end_date,
              show_popup, show_banner, popup_delay, button_text, priority, requires_code, updated_at)
  on public.promotions to anon;
drop policy if exists "publiek leest lopende promoties" on public.promotions;
create policy "publiek leest lopende promoties" on public.promotions for select to anon
  using (is_active and (now() at time zone 'Europe/Brussels')::date between start_date and end_date);

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

-- ------------------------------------------------------- promotieprijzen ---
-- Interne hulpfuncties (niet publiek aanroepbaar). De korting wordt altijd hier,
-- server-side, berekend: de browser kan geen prijs doorgeven die ook echt gebruikt wordt.

-- Staat de promocode klaar voor gebruik? 'ok' | 'invalid' | 'used' (dit e-mailadres gebruikte hem al)
create or replace function public._promo_code_state(p_slug text, p_price numeric, p_code text, p_email text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select p.id into v_id
    from public.promotions p
   where p.promo_code = p_code
     and p.is_active
     and (now() at time zone 'Europe/Brussels')::date between p.start_date and p.end_date
     and (p.service_slug is null or p.service_slug = p_slug)
   limit 1;
  if v_id is null or coalesce(p_price, 0) <= 0 then return 'invalid'; end if;
  if p_email is not null and exists (
       select 1 from public.bookings b
        where b.promotion_id = v_id and lower(b.client_email) = p_email and b.status = 'bevestigd') then
    return 'used';
  end if;
  return 'ok';
end;
$$;

-- Beste toepasbare promotie voor een behandeling: lopend, voor deze behandeling (of alle),
-- automatisch of met de ingevulde code, nog niet gebruikt door dit e-mailadres.
-- Meerdere promoties worden nooit gecombineerd: de grootste korting wint (daarna prioriteit).
create or replace function public._pick_promotion(p_slug text, p_price numeric, p_code text, p_email text)
returns public.promotions
language sql
stable
security definer
set search_path = ''
as $$
  select p.*
    from public.promotions p
   where p.is_active
     and p_price > 0
     and (now() at time zone 'Europe/Brussels')::date between p.start_date and p.end_date
     and (p.service_slug is null or p.service_slug = p_slug)
     and (p.promo_code is null or p.promo_code = p_code)
     and (p_email is null or not exists (
           select 1 from public.bookings b
            where b.promotion_id = p.id and lower(b.client_email) = p_email and b.status = 'bevestigd'))
   order by case p.discount_type when 'percentage' then round(p_price * p.discount_value / 100, 2)
                                 else least(p.discount_value, p_price) end desc,
            p.priority desc, p.created_at
   limit 1;
$$;
-- Supabase geeft nieuwe functies standaard ook rechten aan anon/authenticated; daarom hier uitdrukkelijk
-- ook van die rollen afnemen. Anders kon een bezoeker deze functies via de API aanroepen
-- (bv. nagaan of een e-mailadres een promotie al gebruikte).
revoke all on function public._promo_code_state(text, numeric, text, text) from public, anon, authenticated;
revoke all on function public._pick_promotion(text, numeric, text, text) from public, anon, authenticated;
revoke all on function public.promotions_before_write() from public, anon, authenticated;

-- Prijsberekening voor de afsprakenpagina: normale prijs, korting en prijs na korting.
-- De promocode wordt hier niet bewaard en de prijs in de tabel treatments verandert nooit.
create or replace function public.get_price_quote(p_service text, p_code text default null)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_service public.treatments%rowtype;
  v_code    text := upper(nullif(btrim(coalesce(p_code, '')), ''));
  v_promo   public.promotions%rowtype;
  v_list    numeric(7,2);
  v_disc    numeric(7,2) := 0;
  v_state   text := 'none';
begin
  select * into v_service from public.treatments where slug = p_service and active;
  if not found then raise exception 'onbekende_behandeling'; end if;
  v_list := v_service.price_eur;

  if v_code is not null then
    v_state := public._promo_code_state(v_service.slug, v_list, v_code, null);
  end if;
  if v_state <> 'ok' then v_code := null; end if;

  select * into v_promo from public._pick_promotion(v_service.slug, v_list, v_code, null);
  if v_promo.id is not null then
    v_disc := case v_promo.discount_type when 'percentage' then round(v_list * v_promo.discount_value / 100, 2)
                                         else least(v_promo.discount_value, v_list) end;
  end if;

  return json_build_object(
    'list_price', v_list,
    'discount', v_disc,
    'price', v_list - v_disc,
    'promotion', case when v_promo.id is null then null else v_promo.title end,
    'code_status', v_state
  );
end;
$$;

-- ------------------------------------------------------------------ boeken ---
-- Oude signatuur (zonder promotie) vervangen door een uitgebreide met optionele parameters:
-- bestaande aanroepen met de oorspronkelijke 7 parameters blijven werken.
drop function if exists public.book_appointment(text, date, time, text, text, text, text);
create or replace function public.book_appointment(
  p_service text,
  p_date    date,
  p_start   time,
  p_name    text,
  p_email   text,
  p_phone   text default null,
  p_notes   text default null,
  p_promo_code     text    default null,  -- optionele promocode
  p_expected_price numeric default null   -- prijs die de klant zag; wijkt de echte prijs af, dan wordt er niet geboekt
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
  v_promo    public.promotions%rowtype;
  v_code     text := upper(nullif(btrim(coalesce(p_promo_code, '')), ''));
  v_state    text;
  v_list     numeric(7,2);
  v_disc     numeric(7,2) := 0;
  v_final    numeric(7,2);
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

  -- Promotie: de prijs wordt hier berekend. De originele prijs in treatments blijft ongewijzigd.
  v_list := v_service.price_eur;
  if v_code is not null then
    v_state := public._promo_code_state(v_service.slug, v_list, v_code, p_email);
    if v_state = 'invalid' then raise exception 'ongeldige_code'; end if;
    if v_state = 'used'    then raise exception 'code_al_gebruikt'; end if;
  end if;
  select * into v_promo from public._pick_promotion(v_service.slug, v_list, v_code, p_email);
  if v_promo.id is not null then
    v_disc := case v_promo.discount_type when 'percentage' then round(v_list * v_promo.discount_value / 100, 2)
                                         else least(v_promo.discount_value, v_list) end;
  end if;
  v_final := v_list - v_disc;
  if p_expected_price is not null and p_expected_price <> v_final then
    raise exception 'prijs_gewijzigd:%', v_final;
  end if;

  begin
    insert into public.bookings (service_slug, service_name, price_eur, booking_date, start_time, end_time, blocked_until,
                                 client_name, client_email, client_phone, notes,
                                 list_price_eur, discount_eur, promotion_id, promotion_title, promo_code)
    values (v_service.slug, v_service.name, v_final, p_date, p_start, v_end,
            case when v_end + make_interval(mins => buffer_minutes) < v_end then time '23:59:59'
                 else v_end + make_interval(mins => buffer_minutes) end,
            p_name, p_email, p_phone, p_notes,
            v_list, v_disc, v_promo.id, v_promo.title, case when v_promo.id is not null then v_promo.promo_code end)
    returning id into v_id;
  exception
    when exclusion_violation then raise exception 'tijdslot_bezet';
    when unique_violation    then raise exception 'promotie_al_gebruikt';
    when check_violation     then raise exception 'ongeldige_gegevens';
  end;

  return json_build_object(
    'id', v_id,
    'service', v_service.name,
    'date', p_date,
    'start', to_char(p_start, 'HH24:MI'),
    'end', to_char(v_end, 'HH24:MI'),
    'list_price', v_list,
    'discount', v_disc,
    'price', v_final,
    'promotion', v_promo.title
  );
end;
$$;

-- Enkel deze twee functies zijn publiek aanroepbaar.
revoke all on function public.get_booked_slots(date, date) from public;
revoke all on function public.book_appointment(text, date, time, text, text, text, text, text, numeric) from public;
revoke all on function public.get_price_quote(text, text) from public;
grant execute on function public.get_booked_slots(date, date) to anon, authenticated;
grant execute on function public.book_appointment(text, date, time, text, text, text, text, text, numeric) to anon, authenticated;
grant execute on function public.get_price_quote(text, text) to anon, authenticated;

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
revoke all on function public.is_admin() from public, anon;
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

-- Promoties beheren: enkel admins, alle bewerkingen.
grant select, insert, update, delete on public.promotions to authenticated;
drop policy if exists "admin beheert promoties" on public.promotions;
create policy "admin beheert promoties" on public.promotions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Afbeeldingen voor promoties: openbare map "promotions" (bezoekers zien de afbeelding,
-- maar kunnen niets uploaden, wijzigen of de map doorbladeren). Enkel admins beheren de bestanden.
do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage niet gevonden: map "promotions" overgeslagen.';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('promotions', 'promotions', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];
  execute 'drop policy if exists "admin beheert promotiebeelden" on storage.objects';
  execute $p$create policy "admin beheert promotiebeelden" on storage.objects for all to authenticated
             using (bucket_id = 'promotions' and public.is_admin())
             with check (bucket_id = 'promotions' and public.is_admin())$p$;
end;
$$;

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
