-- =============================================================================
-- Eluneya — controle van de database na een migratie (ALLEEN LEZEN: enkel SELECT, wijzigt niets)
--
-- Uitvoeren: Supabase-dashboard → SQL Editor → plak dit bestand → Run.
-- Resultaat: één rij per controle. Kolom "ok":
--     true  = in orde        false = NIET in orde, kijk bij "detail"        null = enkel informatie
-- Controles met area = 'agenda' horen bij schema.sql, 'shop' bij shop.sql, 'veiligheid' bij beide.
-- Is een deel nog niet toegepast, dan staat die area terecht op false (bv. 'shop' vóór shop.sql).
-- =============================================================================
with
expected(tbl, area) as (values
  ('treatments', 'agenda'), ('opening_hours', 'agenda'), ('closures', 'agenda'), ('bookings', 'agenda'), ('promotions', 'agenda'), ('admins', 'agenda'),
  ('product_categories', 'shop'), ('brands', 'shop'), ('products', 'shop'), ('product_attributes', 'shop'),
  ('product_images', 'shop'), ('product_variants', 'shop'), ('orders', 'shop'), ('order_items', 'shop')),
allowed_anon_fn(fname) as (values ('get_booked_slots'), ('book_appointment'), ('get_price_quote'), ('place_order'), ('_valid_product_attributes')),
sensitive(tbl) as (values ('admins'), ('bookings'), ('closures'), ('treatments'), ('opening_hours'), ('orders'), ('order_items')),
-- Tellingen van tabellen die (nog) niet hoeven te bestaan: de query-tekst wordt pas gekozen als de tabel er is.
cnt as (select
  coalesce((xpath('/row/c/text()', query_to_xml(case when to_regclass('public.admins') is null then 'select 0 as c' else 'select count(*) as c from public.admins' end, false, true, '')))[1]::text::int, 0) as admins,
  coalesce((xpath('/row/c/text()', query_to_xml(case when to_regclass('public.product_categories') is null then 'select 0 as c'
        else 'select count(*) as c from public.product_categories where slug in (''parfums'', ''beauty'', ''wellness'', ''workshops'', ''e-books'', ''andere-producten'')' end, false, true, '')))[1]::text::int, 0) as cats,
  coalesce((xpath('/row/c/text()', query_to_xml(case when to_regclass('public.treatments') is null then 'select 0 as c' else 'select count(*) as c from public.treatments where active' end, false, true, '')))[1]::text::int, 0) as treatments,
  coalesce((xpath('/row/c/text()', query_to_xml(case when to_regclass('public.opening_hours') is null then 'select 0 as c' else 'select count(*) as c from public.opening_hours' end, false, true, '')))[1]::text::int, 0) as hours)

-- 1. Bestaan de verwachte tabellen?
select e.area, 'tabel ' || e.tbl || ' bestaat' as controle,
       to_regclass('public.' || e.tbl) is not null as ok,
       case when to_regclass('public.' || e.tbl) is null then 'ontbreekt' else 'aanwezig' end as detail
  from expected e

union all
-- 2. Staat RLS aan op ELKE tabel in public (ook oude)?
select 'veiligheid', 'RLS aan op alle tabellen in public',
       not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
       coalesce((select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity), 'alle tabellen hebben RLS')

union all
-- 3. Gevoelige tabellen: anon heeft er GEEN enkel recht op (ook geen kolomrechten)
select 'veiligheid', 'anon heeft geen rechten op ' || s.tbl,
       case when to_regclass('public.' || s.tbl) is null then true
            else not (has_table_privilege('anon', 'public.' || s.tbl, 'select, insert, update, delete, truncate, references, trigger')
                      or exists (select 1 from information_schema.column_privileges cp
                                  where cp.table_schema = 'public' and cp.table_name = s.tbl and cp.grantee = 'anon')) end,
       case when to_regclass('public.' || s.tbl) is null then 'tabel bestaat (nog) niet' else 'geen rechten voor anon' end
  from sensitive s

union all
-- 4. Geen enkele tabel in public laat anon schrijven (insert/update/delete/truncate), behalve de oude appointments (zie plan)
select 'veiligheid', 'anon kan nergens schrijven (behalve oude appointments, enkel via RLS)',
       not exists (select 1 from information_schema.role_table_grants g
                    where g.table_schema = 'public' and g.grantee = 'anon' and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
                      and g.table_name not in ('appointments', 'services')
                      and g.table_name in (select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r')),
       coalesce((select string_agg(distinct g.table_name || ':' || g.privilege_type, ', ') from information_schema.role_table_grants g
                  where g.table_schema = 'public' and g.grantee = 'anon' and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
                    and g.table_name not in ('appointments', 'services')
                      and g.table_name in (select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r')), 'geen schrijfrechten')

union all
-- 5. Voorraad, promocode en interne kolommen zijn niet leesbaar voor anon
select 'veiligheid', 'anon kan products.' || c.col || ' niet lezen',
       case when to_regclass('public.products') is null then true else not has_column_privilege('anon', 'public.products', c.col, 'select') end,
       'kolomrecht ontzegd'
  from (values ('stock_qty'), ('track_stock'), ('is_active')) c(col)
union all
select 'veiligheid', 'anon kan product_variants.stock_qty niet lezen',
       case when to_regclass('public.product_variants') is null then true else not has_column_privilege('anon', 'public.product_variants', 'stock_qty', 'select') end, 'kolomrecht ontzegd'
union all
select 'veiligheid', 'anon kan promotions.promo_code niet lezen',
       case when to_regclass('public.promotions') is null then true else not has_column_privilege('anon', 'public.promotions', 'promo_code', 'select') end, 'kolomrecht ontzegd'

union all
-- 6. Welke functies in public kan anon uitvoeren? Enkel de bedoelde publieke functies.
select 'veiligheid', 'anon kan enkel de bedoelde functies uitvoeren',
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute')
                      and p.proname not in (select fname from allowed_anon_fn)),
       'uitvoerbaar door anon: ' || coalesce((select string_agg(distinct p.proname, ', ' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute')), '(geen)')

union all
-- 7. Beheerfuncties: is_admin() niet voor anon; de statuswachter en hulpfuncties niet voor anon/authenticated
select 'veiligheid', 'is_admin() is niet uitvoerbaar door anon',
       case when to_regprocedure('public.is_admin()') is null then true else not has_function_privilege('anon', 'public.is_admin()', 'execute') end, 'ontzegd'
union all
select 'shop', 'interne functies niet uitvoerbaar door anon/authenticated',
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname in ('_orders_status_guard', '_shop_touch', 'promotions_before_write', '_promo_code_state', '_pick_promotion')
                      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
       'ontzegd'

union all
-- 8. Geen RLS-policy voor anon op gevoelige tabellen (alleen promotions + shopcatalogus mogen)
select 'veiligheid', 'geen anon-policies op ' || s.tbl,
       not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = s.tbl and ('anon' = any (p.roles) or 'public' = any (p.roles))),
       coalesce((select string_agg(p.policyname, ', ') from pg_policies p where p.schemaname = 'public' and p.tablename = s.tbl and ('anon' = any (p.roles) or 'public' = any (p.roles))), 'geen')
  from sensitive s

union all
-- 9. Policies van anon op de catalogus tonen enkel actieve rijen
select 'shop', 'anon-policy op ' || p.tablename || ' beperkt tot actieve rijen',
       p.qual ilike '%is_active%' or p.tablename in ('product_attributes', 'product_images'),
       p.qual
  from pg_policies p
 where p.schemaname = 'public' and p.tablename in ('product_categories', 'brands', 'products', 'product_variants', 'product_attributes', 'product_images') and 'anon' = any (p.roles)

union all
-- 10. Er is minstens één beheerder
select 'agenda', 'minstens één beheerder in admins', (select admins from cnt) >= 1, (select admins::text from cnt) || ' beheerder(s)'

union all
-- 11. Opslagmappen (afbeeldingen)
select 'shop', 'opslagmap ' || b.id || ' is openbaar met limiet en bestandstypes',
       coalesce((select (bk.public and bk.file_size_limit is not null and bk.allowed_mime_types is not null) from storage.buckets bk where bk.id = b.id), false),
       coalesce((select 'public=' || bk.public || ', limiet=' || coalesce(bk.file_size_limit::text, '-') from storage.buckets bk where bk.id = b.id), 'ontbreekt')
  from (values ('promotions'), ('products')) b(id)
union all
select 'shop', 'storage.objects: enkel admins beheren de mappen products/promotions',
       not exists (select 1 from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects'
                    and (p.qual ilike '%''products''%' or p.qual ilike '%''promotions''%') and p.qual not ilike '%is_admin%'),
       'policies met is_admin()'

union all
-- 12. Basisgegevens
select 'shop', 'basiscategorieën aanwezig (6)', (select cats from cnt) = 6, (select cats::text from cnt) || ' basiscategorieën'
union all
select 'agenda', 'behandelingen (10 actieve) en openingsuren (4 dagen) aanwezig', (select treatments from cnt) = 10 and (select hours from cnt) = 4,
       (select treatments::text from cnt) || ' actieve behandelingen, ' || (select hours::text from cnt) || ' openingsdagen'

union all
-- 13. Informatie: oude tabellen (moeten na de migratie nog evenveel rijen hebben als ervoor)
select 'info', 'oude tabel ' || t.tbl || ': aantal rijen', null::boolean,
       case when to_regclass('public.' || t.tbl) is null then 'bestaat niet' else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.' || t.tbl, false, true, '')))[1]::text end
  from (values ('services'), ('appointments')) t(tbl)
union all
select 'info', 'oude policies op appointments', null::boolean,
       coalesce((select string_agg(p.policyname || ' (' || array_to_string(p.roles, ',') || ', ' || p.cmd || ')', ' | ') from pg_policies p where p.schemaname = 'public' and p.tablename = 'appointments'), 'geen')
union all
select 'info', 'RLS-tabellen in public', null::boolean, (select string_agg(c.relname, ', ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r')

order by 1, 2;
