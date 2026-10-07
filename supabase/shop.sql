-- =============================================================================
-- Eluneya — webshop (Supabase / PostgreSQL)
--
-- Uitvoeren: Supabase-dashboard → SQL Editor → plak dit hele bestand → Run.
-- Het script is veilig om opnieuw uit te voeren (idempotent) en staat los van
-- schema.sql (agenda). Het maakt zelf de tabel admins en is_admin() aan als ze
-- nog niet bestaan; de definitie is identiek aan die in schema.sql.
--
-- Ontwerp (zelfde principes als de agenda):
--   * Bezoekers (rol anon) lezen enkel ACTIEVE producten en categorieën, en enkel
--     de kolommen die publiek nodig zijn (de voorraad zelf, stock_qty, is niet leesbaar;
--     is_available geeft aan of iets op voorraad is).
--   * Bezoekers kunnen NOOIT rechtstreeks in orders / order_items lezen of schrijven.
--     Ze gebruiken enkel place_order(): prijzen, kortingen, voorraad en totaal worden
--     server-side berekend; de browser kan geen prijs doorgeven die ook echt gebruikt wordt.
--   * Een bestelling is een BESTELAANVRAAG: er is geen betaling in dit script.
--     payment_status / payment_provider / payment_reference liggen klaar voor later
--     (Mollie of een andere provider) zonder dat tabellen herschreven moeten worden.
--   * Enkel accounts in de tabel admins beheren producten, categorieën, voorraad en bestellingen.
--   * Producttypes met eigen velden (parfum, later skincare, kaarsen …) gebruiken
--     product_attributes (jsonb) in plaats van extra kolommen.
-- =============================================================================

-- ------------------------------------------------------------ beheerders ---
-- Identiek aan schema.sql (create ... if not exists / create or replace).
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

-- ---------------------------------------------------------------- hulp ---
create or replace function public._shop_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public._shop_touch() from public, anon, authenticated;

-- ------------------------------------------------------------ categorieën ---
-- attribute_set bepaalt welke extra velden de admin toont ('fragrance' = geurprofiel).
-- parent_id maakt subcategorieën mogelijk (bv. Beauty → Skincare) zonder nieuw ontwerp.
create table if not exists public.product_categories (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  name          text not null check (char_length(btrim(name)) between 2 and 80),
  description   text check (description is null or char_length(description) <= 600),
  image_url     text check (image_url is null or (char_length(image_url) <= 500 and image_url ~ '^(https://|/)[^\s]+$')),
  parent_id     uuid references public.product_categories(id) on delete restrict,
  attribute_set text not null default 'none' check (attribute_set in ('none', 'fragrance')),
  sort_order    integer not null default 0 check (sort_order between 0 and 9999),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (parent_id is null or parent_id <> id)
);
drop trigger if exists product_categories_touch on public.product_categories;
create trigger product_categories_touch before update on public.product_categories
  for each row execute function public._shop_touch();

create table if not exists public.brands (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  description text check (description is null or char_length(description) <= 600),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists brands_touch on public.brands;
create trigger brands_touch before update on public.brands
  for each row execute function public._shop_touch();

-- --------------------------------------------------------------- producten ---
--   product_type: 'physical' (verzending/afhalen), 'digital' (e-book), 'workshop' (datum/plaats via overleg).
--   price_eur            normale prijs
--   compare_at_price_eur "oude prijs" (doorgestreept getoond, puur informatief)
--   sale_price_eur       promotieprijs, optioneel beperkt tot sale_starts_at … sale_ends_at
--   stock_qty            enkel relevant als track_stock = true
--   availability         in_stock | out_of_stock | preorder | on_request (enkel via WhatsApp bestellen)
create table if not exists public.products (
  id                   uuid primary key default gen_random_uuid(),
  slug                 text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 90),
  category_id          uuid not null references public.product_categories(id) on delete restrict,
  brand_id             uuid references public.brands(id) on delete set null,
  name                 text not null check (char_length(btrim(name)) between 2 and 120),
  short_description    text check (short_description is null or char_length(short_description) <= 220),
  description          text check (description is null or char_length(description) <= 5000),
  ingredients          text check (ingredients is null or char_length(ingredients) <= 3000),
  content_label        text check (content_label is null or char_length(content_label) <= 40),   -- bv. '50 ml'
  product_type         text not null default 'physical' check (product_type in ('physical', 'digital', 'workshop')),
  sku                  text check (sku is null or char_length(sku) between 1 and 60),
  price_eur            numeric(8,2) not null check (price_eur >= 0 and price_eur <= 10000),
  compare_at_price_eur numeric(8,2) check (compare_at_price_eur is null or compare_at_price_eur <= 10000),
  sale_price_eur       numeric(8,2) check (sale_price_eur is null or sale_price_eur >= 0),
  sale_starts_at       timestamptz,
  sale_ends_at         timestamptz,
  track_stock          boolean not null default false,
  stock_qty            integer not null default 0 check (stock_qty >= 0 and stock_qty <= 100000),
  availability         text not null default 'in_stock' check (availability in ('in_stock', 'out_of_stock', 'preorder', 'on_request')),
  is_active            boolean not null default false,   -- nieuw product is pas zichtbaar als Aida het activeert
  is_featured          boolean not null default false,
  sort_order           integer not null default 0 check (sort_order between 0 and 9999),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- is_available: kan nu besteld worden (voorraad of voorbestelling). Publiek leesbaar, stock_qty niet.
  is_available         boolean generated always as (
                         availability = 'preorder'
                         or (availability = 'in_stock' and (not track_stock or stock_qty > 0))
                       ) stored,
  constraint products_compare_ok check (compare_at_price_eur is null or compare_at_price_eur > price_eur),
  constraint products_sale_ok    check (sale_price_eur is null or sale_price_eur < price_eur),
  constraint products_sale_dates check (sale_starts_at is null or sale_ends_at is null or sale_ends_at > sale_starts_at)
);
create unique index if not exists products_sku_uidx on public.products (lower(sku)) where sku is not null;
create index if not exists products_category_idx on public.products (category_id, sort_order) where is_active;
create index if not exists products_featured_idx on public.products (sort_order) where is_active and is_featured;
create index if not exists products_brand_idx    on public.products (brand_id);
drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public._shop_touch();

-- Extra, categorie-afhankelijke gegevens als jsonb. Voor parfums:
--   { "fragrance_family": "Oriëntaals", "concentration": "Eau de Parfum",
--     "notes": { "top": ["bergamot","citroen"], "heart": ["jasmijn","roos"], "base": ["vanille","musk","amber"] } }
-- Andere sleutels mogen (skincare, kaarsen …); enkel de bovenstaande worden gecontroleerd.
-- Opmerking: deze functie blijft uitvoerbaar; Postgres controleert het recht ook bij CHECK-constraints tijdens het schrijven.
-- Ze is onschadelijk (enkel validatie van meegegeven jsonb).
create or replace function public._valid_product_attributes(a jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
  v jsonb;
  e jsonb;
begin
  if a is null or jsonb_typeof(a) <> 'object' or octet_length(a::text) > 8000 then return false; end if;
  if a ? 'fragrance_family' then
    if jsonb_typeof(a->'fragrance_family') <> 'string' or char_length(a->>'fragrance_family') > 80 then return false; end if;
  end if;
  if a ? 'concentration' then
    if jsonb_typeof(a->'concentration') <> 'string' or char_length(a->>'concentration') > 80 then return false; end if;
  end if;
  if a ? 'notes' then
    if jsonb_typeof(a->'notes') <> 'object' then return false; end if;
    for k in select jsonb_object_keys(a->'notes') loop
      if k not in ('top', 'heart', 'base') then return false; end if;
      v := a->'notes'->k;
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 20 then return false; end if;
      for e in select * from jsonb_array_elements(v) loop
        if jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') not between 1 and 60 then return false; end if;
      end loop;
    end loop;
  end if;
  return true;
end;
$$;

create table if not exists public.product_attributes (
  product_id uuid primary key references public.products(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb check (public._valid_product_attributes(data)),
  updated_at timestamptz not null default now()
);
drop trigger if exists product_attributes_touch on public.product_attributes;
create trigger product_attributes_touch before update on public.product_attributes
  for each row execute function public._shop_touch();

create table if not exists public.product_images (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  url         text not null check (char_length(url) <= 500 and url ~ '^(https://|/)[^\s]+$'),
  alt         text check (alt is null or char_length(alt) <= 200),
  sort_order  integer not null default 0 check (sort_order between 0 and 99),
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists product_images_product_idx on public.product_images (product_id, sort_order);
create unique index if not exists product_images_primary_uidx on public.product_images (product_id) where is_primary;

-- Varianten (bv. 30 ml / 50 ml / 100 ml). Fundering: de winkelmand en place_order() kennen ze al;
-- de admin beheert ze pas als Aida varianten nodig heeft. Een variant zonder eigen prijs erft de productprijs.
create table if not exists public.product_variants (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  label       text not null check (char_length(btrim(label)) between 1 and 60),
  sku         text check (sku is null or char_length(sku) between 1 and 60),
  price_eur   numeric(8,2) check (price_eur is null or (price_eur >= 0 and price_eur <= 10000)),
  stock_qty   integer check (stock_qty is null or (stock_qty >= 0 and stock_qty <= 100000)),   -- null = voorraad niet bijgehouden
  sort_order  integer not null default 0 check (sort_order between 0 and 99),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  is_available boolean generated always as (is_active and (stock_qty is null or stock_qty > 0)) stored
);
create unique index if not exists product_variants_sku_uidx on public.product_variants (lower(sku)) where sku is not null;
create index if not exists product_variants_product_idx on public.product_variants (product_id, sort_order);

-- -------------------------------------------------------------- bestellingen ---
create sequence if not exists public.order_number_seq start 1001;

create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  order_number     text not null unique default ('EL-' || nextval('public.order_number_seq')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  status           text not null default 'nieuw' check (status in ('nieuw', 'in_behandeling', 'klaar', 'afgerond', 'geannuleerd')),
  customer_name    text not null check (char_length(customer_name) between 2 and 120),
  customer_email   text not null check (char_length(customer_email) <= 200 and customer_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  customer_phone   text check (customer_phone is null or char_length(customer_phone) <= 40),
  delivery_method  text not null default 'afhalen' check (delivery_method in ('afhalen', 'verzenden')),
  ship_street      text check (ship_street is null or char_length(ship_street) <= 160),
  ship_postal      text check (ship_postal is null or char_length(ship_postal) <= 20),
  ship_city        text check (ship_city is null or char_length(ship_city) <= 100),
  customer_notes   text check (customer_notes is null or char_length(customer_notes) <= 1000),
  subtotal_eur     numeric(9,2) not null check (subtotal_eur >= 0),   -- som van de normale prijzen
  discount_eur     numeric(9,2) not null default 0 check (discount_eur >= 0),
  shipping_eur     numeric(9,2) not null default 0 check (shipping_eur >= 0),
  total_eur        numeric(9,2) not null check (total_eur >= 0),
  -- Betaling staat bewust los van de bestelling: later invullen vanuit een provider (Mollie …).
  payment_status    text not null default 'open' check (payment_status in ('open', 'betaald', 'terugbetaald')),
  payment_provider  text check (payment_provider is null or char_length(payment_provider) <= 40),
  payment_reference text check (payment_reference is null or char_length(payment_reference) <= 120),
  terms_accepted_at timestamptz not null default now(),
  admin_notes      text check (admin_notes is null or char_length(admin_notes) <= 2000),
  constraint orders_ship_address check (delivery_method = 'afhalen' or (ship_street is not null and ship_postal is not null and ship_city is not null))
);
create index if not exists orders_created_idx on public.orders (created_at desc);
create index if not exists orders_status_idx  on public.orders (status, created_at desc);
create index if not exists orders_email_idx   on public.orders (lower(customer_email));
drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public._shop_touch();

-- Regels bewaren een momentopname (naam, prijs): een bestelling blijft gelijk als het product later wijzigt of verdwijnt.
create table if not exists public.order_items (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders(id) on delete cascade,
  product_id     uuid references public.products(id) on delete set null,
  variant_id     uuid references public.product_variants(id) on delete set null,
  sku            text,
  product_name   text not null,
  variant_label  text,
  unit_price_eur numeric(8,2) not null check (unit_price_eur >= 0),   -- betaalde prijs per stuk
  list_price_eur numeric(8,2) not null check (list_price_eur >= 0),   -- normale prijs per stuk
  quantity       integer not null check (quantity between 1 and 50),
  line_total_eur numeric(9,2) not null check (line_total_eur >= 0),
  restocked      boolean not null default false                      -- voorraad al teruggezet na annulatie
);
create index if not exists order_items_order_idx on public.order_items (order_id);

-- Voorraad terugzetten bij annulatie (eenmalig per regel); een geannuleerde bestelling blijft geannuleerd.
create or replace function public._orders_status_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if old.status = 'geannuleerd' then
      raise exception 'geannuleerd_is_definitief' using errcode = '23514';
    end if;
    if new.status = 'geannuleerd' then
      update public.products p set stock_qty = p.stock_qty + i.quantity
        from public.order_items i
       where i.order_id = new.id and not i.restocked and i.variant_id is null
         and p.id = i.product_id and p.track_stock;
      update public.product_variants v set stock_qty = v.stock_qty + i.quantity
        from public.order_items i
       where i.order_id = new.id and not i.restocked and i.variant_id is not null
         and v.id = i.variant_id and v.stock_qty is not null;
      update public.order_items set restocked = true where order_id = new.id and not restocked;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists orders_status_guard on public.orders;
create trigger orders_status_guard before update on public.orders
  for each row execute function public._orders_status_guard();
revoke all on function public._orders_status_guard() from public, anon, authenticated;

-- ----------------------------------------------------------- toegangsrechten ---
alter table public.product_categories enable row level security;
alter table public.brands             enable row level security;
alter table public.products           enable row level security;
alter table public.product_attributes enable row level security;
alter table public.product_images     enable row level security;
alter table public.product_variants   enable row level security;
alter table public.orders             enable row level security;
alter table public.order_items        enable row level security;

revoke all on public.product_categories, public.brands, public.products, public.product_attributes,
              public.product_images, public.product_variants, public.orders, public.order_items
  from anon, authenticated;
revoke all on sequence public.order_number_seq from anon, authenticated;

-- Publiek (anon): enkel actieve zaken, enkel de nodige kolommen. stock_qty en track_stock blijven privé.
-- is_active van categorieën moet leesbaar zijn omdat de policy van products ernaar kijkt (enkel actieve rijen zijn zichtbaar).
grant select (id, slug, name, description, image_url, parent_id, attribute_set, sort_order, is_active)
  on public.product_categories to anon;
grant select (id, slug, name, description) on public.brands to anon;
grant select (id, slug, category_id, brand_id, name, short_description, description, ingredients, content_label,
              product_type, sku, price_eur, compare_at_price_eur, sale_price_eur, sale_starts_at, sale_ends_at,
              availability, is_available, is_featured, sort_order, created_at, updated_at)
  on public.products to anon;
grant select (product_id, data) on public.product_attributes to anon;
grant select (id, product_id, url, alt, sort_order, is_primary) on public.product_images to anon;
grant select (id, product_id, label, sku, price_eur, sort_order, is_available) on public.product_variants to anon;

drop policy if exists "publiek leest actieve categorieen" on public.product_categories;
create policy "publiek leest actieve categorieen" on public.product_categories for select to anon
  using (is_active);

drop policy if exists "publiek leest actieve merken" on public.brands;
create policy "publiek leest actieve merken" on public.brands for select to anon
  using (is_active);

drop policy if exists "publiek leest actieve producten" on public.products;
create policy "publiek leest actieve producten" on public.products for select to anon
  using (is_active and exists (select 1 from public.product_categories c where c.id = category_id and c.is_active));

drop policy if exists "publiek leest attributen" on public.product_attributes;
create policy "publiek leest attributen" on public.product_attributes for select to anon
  using (exists (select 1 from public.products p where p.id = product_id));   -- RLS van products filtert op actief

drop policy if exists "publiek leest productbeelden" on public.product_images;
create policy "publiek leest productbeelden" on public.product_images for select to anon
  using (exists (select 1 from public.products p where p.id = product_id));

drop policy if exists "publiek leest actieve varianten" on public.product_variants;
create policy "publiek leest actieve varianten" on public.product_variants for select to anon
  using (is_active and exists (select 1 from public.products p where p.id = product_id));

-- Beheer: enkel admins, alle bewerkingen op de catalogus.
grant select, insert, update, delete on public.product_categories, public.brands, public.products,
  public.product_attributes, public.product_images, public.product_variants to authenticated;

drop policy if exists "admin beheert categorieen" on public.product_categories;
create policy "admin beheert categorieen" on public.product_categories for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin beheert merken" on public.brands;
create policy "admin beheert merken" on public.brands for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin beheert producten" on public.products;
create policy "admin beheert producten" on public.products for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin beheert attributen" on public.product_attributes;
create policy "admin beheert attributen" on public.product_attributes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin beheert productbeelden" on public.product_images;
create policy "admin beheert productbeelden" on public.product_images for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin beheert varianten" on public.product_variants;
create policy "admin beheert varianten" on public.product_variants for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Bestellingen: admins lezen alles en wijzigen enkel status/betaalstatus/notities. Nooit verwijderen,
-- en bedragen of klantgegevens kunnen niet achteraf aangepast worden.
grant select on public.orders, public.order_items to authenticated;
grant update (status, payment_status, payment_provider, payment_reference, admin_notes) on public.orders to authenticated;
drop policy if exists "admin leest bestellingen" on public.orders;
drop policy if exists "admin wijzigt bestellingen" on public.orders;
drop policy if exists "admin leest bestelregels" on public.order_items;
create policy "admin leest bestellingen"  on public.orders      for select to authenticated using (public.is_admin());
create policy "admin wijzigt bestellingen" on public.orders     for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin leest bestelregels"  on public.order_items for select to authenticated using (public.is_admin());

-- ------------------------------------------------------------ prijsberekening ---
-- Actuele verkoopprijs van een product (promotieprijs enkel binnen de actieperiode).
create or replace function public._product_price(p public.products)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case
           when p.sale_price_eur is not null
            and (p.sale_starts_at is null or now() >= p.sale_starts_at)
            and (p.sale_ends_at   is null or now() <= p.sale_ends_at)
           then p.sale_price_eur
           else p.price_eur
         end;
$$;
revoke all on function public._product_price(public.products) from public, anon, authenticated;

-- ------------------------------------------------------------ bestellen ---
-- p_items: [{"product_id": "<uuid>", "variant_id": "<uuid>" (optioneel), "qty": 1}, ...]
-- Alles wordt hier gecontroleerd en berekend. Wijkt het totaal af van wat de klant zag, dan wordt er
-- niet besteld (foutcode prijs_gewijzigd:<nieuw totaal>) zodat niemand verrast wordt.
create or replace function public.place_order(
  p_items          jsonb,
  p_name           text,
  p_email          text,
  p_phone          text    default null,
  p_delivery       text    default 'afhalen',
  p_street         text    default null,
  p_postal         text    default null,
  p_city           text    default null,
  p_notes          text    default null,
  p_consent        boolean default false,
  p_expected_total numeric default null
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_max_lines  constant integer := 20;
  c_max_qty    constant integer := 10;
  c_max_open   constant integer := 3;   -- openstaande aanvragen per e-mailadres (tegen misbruik)
  r            record;
  v_prod       public.products%rowtype;
  v_var        public.product_variants%rowtype;
  v_cat_active boolean;
  v_unit       numeric(8,2);
  v_list       numeric(8,2);
  v_subtotal   numeric(9,2) := 0;
  v_total      numeric(9,2) := 0;
  v_order      public.orders%rowtype;
  v_open       integer;
  v_lines      jsonb := '[]'::jsonb;
  v_has_var    boolean;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and c_max_lines then
    raise exception 'lege_bestelling';
  end if;
  if p_consent is not true then raise exception 'akkoord_vereist'; end if;

  p_name  := nullif(btrim(coalesce(p_name, '')), '');
  p_email := lower(nullif(btrim(coalesce(p_email, '')), ''));
  p_phone := nullif(btrim(coalesce(p_phone, '')), '');
  p_notes := nullif(btrim(coalesce(p_notes, '')), '');
  p_street := nullif(btrim(coalesce(p_street, '')), '');
  p_postal := nullif(btrim(coalesce(p_postal, '')), '');
  p_city   := nullif(btrim(coalesce(p_city, '')), '');
  if p_name is null or p_email is null then raise exception 'ongeldige_gegevens'; end if;
  if p_delivery not in ('afhalen', 'verzenden') then raise exception 'ongeldige_gegevens'; end if;
  if p_delivery = 'verzenden' and (p_street is null or p_postal is null or p_city is null) then
    raise exception 'adres_vereist';
  end if;
  if p_delivery = 'afhalen' then p_street := null; p_postal := null; p_city := null; end if;

  select count(*) into v_open from public.orders o
   where lower(o.customer_email) = p_email and o.status in ('nieuw', 'in_behandeling');
  if v_open >= c_max_open then raise exception 'te_veel_bestellingen'; end if;

  -- Gelijke producten samenvoegen; vaste volgorde (op id) zodat gelijktijdige bestellingen elkaar niet blokkeren.
  for r in
    select (e->>'product_id')::uuid as product_id,
           nullif(e->>'variant_id', '')::uuid as variant_id,
           sum((e->>'qty')::integer)::integer as qty
      from jsonb_array_elements(p_items) e
     group by 1, 2
     order by 1, 2
  loop
    if r.qty is null or r.qty < 1 or r.qty > c_max_qty then raise exception 'ongeldig_aantal'; end if;

    select * into v_prod from public.products where id = r.product_id and is_active for update;
    if not found then raise exception 'product_niet_beschikbaar'; end if;
    select c.is_active into v_cat_active from public.product_categories c where c.id = v_prod.category_id;
    if not coalesce(v_cat_active, false) then raise exception 'product_niet_beschikbaar'; end if;
    if v_prod.availability in ('out_of_stock', 'on_request') then
      raise exception 'product_niet_beschikbaar:%', v_prod.name;
    end if;

    select exists (select 1 from public.product_variants x where x.product_id = v_prod.id and x.is_active) into v_has_var;
    if v_has_var and r.variant_id is null then raise exception 'kies_variant:%', v_prod.name; end if;

    v_unit := public._product_price(v_prod);
    v_list := v_prod.price_eur;

    if r.variant_id is not null then
      select * into v_var from public.product_variants
       where id = r.variant_id and product_id = v_prod.id and is_active for update;
      if not found then raise exception 'product_niet_beschikbaar:%', v_prod.name; end if;
      if v_var.stock_qty is not null then
        if v_var.stock_qty < r.qty then raise exception 'onvoldoende_voorraad:%', v_prod.name; end if;
        update public.product_variants set stock_qty = stock_qty - r.qty where id = v_var.id;
      end if;
      if v_var.price_eur is not null then v_unit := v_var.price_eur; v_list := v_var.price_eur; end if;
    elsif v_prod.track_stock and v_prod.availability = 'in_stock' then
      if v_prod.stock_qty < r.qty then raise exception 'onvoldoende_voorraad:%', v_prod.name; end if;
      update public.products set stock_qty = stock_qty - r.qty where id = v_prod.id;
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_prod.id, 'variant_id', r.variant_id, 'qty', r.qty, 'unit', v_unit, 'list', v_list,
      'pname', v_prod.name, 'vlabel', case when r.variant_id is not null then v_var.label end,
      'psku', coalesce(case when r.variant_id is not null then v_var.sku end, v_prod.sku)));
    v_subtotal := v_subtotal + v_list * r.qty;
    v_total    := v_total    + v_unit * r.qty;
  end loop;

  if p_expected_total is not null and p_expected_total <> v_total then
    raise exception 'prijs_gewijzigd:%', v_total;
  end if;

  begin
    insert into public.orders (customer_name, customer_email, customer_phone, delivery_method,
                               ship_street, ship_postal, ship_city, customer_notes,
                               subtotal_eur, discount_eur, total_eur)
    values (p_name, p_email, p_phone, p_delivery, p_street, p_postal, p_city, p_notes,
            v_subtotal, v_subtotal - v_total, v_total)
    returning * into v_order;
  exception when check_violation then raise exception 'ongeldige_gegevens';
  end;

  insert into public.order_items (order_id, product_id, variant_id, sku, product_name, variant_label,
                                  unit_price_eur, list_price_eur, quantity, line_total_eur)
  select v_order.id, l.product_id, l.variant_id, l.psku, l.pname, l.vlabel, l.unit, l.list, l.qty, l.unit * l.qty
    from jsonb_to_recordset(v_lines) as l(product_id uuid, variant_id uuid, psku text, pname text, vlabel text,
                                          unit numeric, list numeric, qty integer);

  return json_build_object(
    'id', v_order.id,
    'order_number', v_order.order_number,
    'items', (select jsonb_agg(jsonb_build_object('name', l.pname, 'variant', l.vlabel, 'qty', l.qty,
                                                    'unit_price', l.unit, 'line_total', l.unit * l.qty))
                from jsonb_to_recordset(v_lines) as l(pname text, vlabel text, unit numeric, qty integer)),
    'subtotal', v_subtotal,
    'discount', v_subtotal - v_total,
    'total', v_total,
    'delivery', p_delivery
  );
end;
$$;
revoke all on function public.place_order(jsonb, text, text, text, text, text, text, text, text, boolean, numeric) from public;
grant execute on function public.place_order(jsonb, text, text, text, text, text, text, text, text, boolean, numeric) to anon, authenticated;

-- -------------------------------------------------------------- afbeeldingen ---
-- Openbare map "products": bezoekers zien de afbeeldingen, maar kunnen niets uploaden of wijzigen.
do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage niet gevonden: map "products" overgeslagen.';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('products', 'products', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];
  execute 'drop policy if exists "admin beheert productbeelden" on storage.objects';
  execute $p$create policy "admin beheert productbeelden" on storage.objects for all to authenticated
             using (bucket_id = 'products' and public.is_admin())
             with check (bucket_id = 'products' and public.is_admin())$p$;
end;
$$;

-- ------------------------------------------------------------------- start ---
-- Basiscategorieën (bestaande rijen blijven ongemoeid, zodat wijzigingen van Aida niet overschreven worden).
insert into public.product_categories (slug, name, description, attribute_set, sort_order) values
  ('parfums',           'Parfums',           'Geuren om te dragen als een zachte signatuur.',            'fragrance', 10),
  ('beauty',            'Beauty',            'Verzorging die je huid en zintuigen een moment gunt.',     'none',      20),
  ('wellness',          'Wellness',          'Kaarsen, rituelen en kleine momenten van rust.',           'none',      30),
  ('workshops',         'Workshops',         'Samen leren, voelen en tot rust komen.',                   'none',      40),
  ('e-books',           'E-books',           'Digitale gidsen om thuis mee aan de slag te gaan.',        'none',      50),
  ('andere-producten',  'Andere producten',  'Meer van Eluneya.',                                        'none',      90)
on conflict (slug) do nothing;
