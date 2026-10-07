-- =============================================================================
-- Eluneya — DEMOGEGEVENS voor de webshop (enkel voor een test-/ontwikkelomgeving!)
--
-- NIET uitvoeren op de productiedatabase: de producten, merk en prijzen hieronder zijn verzonnen.
-- Voer eerst supabase/shop.sql uit. Veilig om opnieuw uit te voeren.
-- =============================================================================
insert into public.brands (slug, name, description) values
  ('maison-demo', 'Maison Demo', 'Verzonnen merk voor de testomgeving.')
on conflict (slug) do nothing;

with c as (select id from public.product_categories where slug = 'parfums'),
     b as (select id from public.brands where slug = 'maison-demo')
insert into public.products (slug, name, category_id, brand_id, short_description, description, content_label, price_eur,
                             compare_at_price_eur, sale_price_eur, track_stock, stock_qty, sku, is_active, is_featured, sort_order, ingredients)
select v.slug, v.name, c.id, b.id, v.short_description, v.description, v.content_label, v.price, v.compare_at, v.sale,
       true, v.stock, v.sku, true, v.featured, v.sort, 'Alcohol denat., parfum, aqua, limonene, linalool, citral.'
  from c, b, (values
    ('soft-amber',  'Soft Amber',  'Warm, zacht en omhullend.',       'Een rustige signatuur van amber en vanille, voor wie een parfum draagt als een zachte omhelzing.', '50 ml', 89.00, null::numeric, null::numeric, 8, 'DEMO-001', true, 10),
    ('white-petal', 'White Petal', 'Helder, bloemig en luchtig.',     'Jasmijn en roos in een lichte, frisse opening. Een geur voor lange lentedagen.',                   '50 ml', 79.00, 95.00,        69.00,        5, 'DEMO-002', true, 20),
    ('quiet-wood',  'Quiet Wood',  'Zacht hout en musk.',             'Rustig sandelhout met een fluwelen basis van musk. Dagelijks te dragen.',                          '30 ml', 59.00, null,         null,         0, 'DEMO-003', false, 30),
    ('citrus-dawn', 'Citrus Dawn', 'Zonnig, fris en optimistisch.',   'Bergamot en citroen openen deze geur; een zachte muskbasis houdt hem lang vast.',                  '100 ml', 99.00, null,        null,         3, 'DEMO-004', false, 40)
  ) as v(slug, name, short_description, description, content_label, price, compare_at, sale, stock, sku, featured, sort)
on conflict (slug) do nothing;

insert into public.product_attributes (product_id, data)
select p.id, v.data::jsonb from public.products p join (values
  ('soft-amber',  '{"fragrance_family":"Oriëntaals","concentration":"Eau de Parfum","notes":{"top":["bergamot","mandarijn"],"heart":["roos","jasmijn"],"base":["vanille","amber","musk"]}}'),
  ('white-petal', '{"fragrance_family":"Bloemig","concentration":"Eau de Parfum","notes":{"top":["citroen","peer"],"heart":["jasmijn","pioenroos"],"base":["witte musk","cederhout"]}}'),
  ('quiet-wood',  '{"fragrance_family":"Houtig","concentration":"Eau de Toilette","notes":{"top":["kardemom"],"heart":["sandelhout"],"base":["musk","vetiver"]}}'),
  ('citrus-dawn', '{"fragrance_family":"Fris","concentration":"Eau de Toilette","notes":{"top":["bergamot","citroen"],"heart":["neroli"],"base":["musk"]}}')
) as v(slug, data) on v.slug = p.slug
on conflict (product_id) do nothing;

insert into public.product_images (product_id, url, alt, is_primary)
select p.id, '/assets/img/geurbeleving-lg.webp', p.name, true from public.products p
 where p.slug in ('soft-amber', 'white-petal', 'quiet-wood', 'citrus-dawn')
   and not exists (select 1 from public.product_images i where i.product_id = p.id);

with c as (select id from public.product_categories where slug = 'e-books')
insert into public.products (slug, name, category_id, short_description, description, product_type, price_eur, is_active, sort_order)
select 'rustgids', 'De rustgids', c.id, 'Een digitale gids voor dagelijkse rust.', 'Korte oefeningen en rituelen om thuis tot rust te komen (PDF).', 'digital', 14.00, true, 10 from c
on conflict (slug) do nothing;

with c as (select id from public.product_categories where slug = 'workshops')
insert into public.products (slug, name, category_id, short_description, description, product_type, price_eur, is_active, sort_order, availability)
select 'geurworkshop', 'Geurworkshop', c.id, 'Ontdek je eigen geurprofiel.', 'Een avond over geurfamilies en noten. Datum en plaats in overleg.', 'workshop', 45.00, true, 10, 'on_request' from c
on conflict (slug) do nothing;
