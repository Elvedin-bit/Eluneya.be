// Vult de TESTdatabase (stack.mjs) met een demo-assortiment via de REST-API, als admin. Geen productiegegevens.
// Gebruik: node seed_demo.mjs        (voert niets uit zonder lokale teststack)
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = JSON.parse(readFileSync(resolve(here, '.data/env.json'), 'utf8'));
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(env.restUrl)) { console.error('Alleen voor de lokale teststack.'); process.exit(1); }
const H = { apikey: env.anonKey, Authorization: `Bearer ${env.adminJwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const post = async (t, body) => {
  const r = await fetch(`${env.restUrl}/${t}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${t}: ${JSON.stringify(j)}`); return j;
};
const get = async (q) => (await fetch(`${env.restUrl}/${q}`, { headers: H })).json();
const cat = async (slug) => (await get(`product_categories?slug=eq.${slug}&select=id`))[0].id;

const [brand] = await post('brands', { slug: 'maison-demo', name: 'Maison Demo' });
const parfums = await cat('parfums'), ebooks = await cat('e-books'), wellness = await cat('wellness');
const mk = async (p, extra = {}) => (await post('products', { is_active: true, ...p }))[0];

const amber = await mk({ slug: 'soft-amber', name: 'Soft Amber', category_id: parfums, brand_id: brand.id, price_eur: 89, short_description: 'Warm, zacht en omhullend.',
  description: 'Een rustige signatuur van amber en vanille.\n\nDe geur opent helder en landt zacht op de huid.', ingredients: 'Alcohol denat., parfum, aqua.', sku: 'DEMO-SA', is_featured: true, sort_order: 10 });
await post('product_variants', [
  { product_id: amber.id, label: '15 ml', volume_ml: 15, sku: 'DEMO-SA-15', price_eur: 29, stock_qty: 5, sort_order: 0, is_active: true },
  { product_id: amber.id, label: '30 ml', volume_ml: 30, sku: 'DEMO-SA-30', price_eur: 49, stock_qty: 3, sort_order: 1, is_active: true },
  { product_id: amber.id, label: '70 ml', volume_ml: 70, sku: 'DEMO-SA-70', price_eur: 89, stock_qty: 0, sort_order: 2, is_active: true },
]);
await post('product_attributes', { product_id: amber.id, data: { fragrance_family: 'Oriëntaals', concentration: 'Eau de Parfum', notes: { top: ['bergamot', 'mandarijn'], heart: ['roos', 'jasmijn'], base: ['vanille', 'amber', 'musk'] } } });
await post('product_images', { product_id: amber.id, url: '/assets/img/geurbeleving-lg.webp', alt: 'Soft Amber', is_primary: true });

const petal = await mk({ slug: 'white-petal', name: 'White Petal', category_id: parfums, brand_id: brand.id, price_eur: 79, sale_price_eur: 69, short_description: 'Helder, bloemig en luchtig.', sku: 'DEMO-WP', is_featured: true, sort_order: 20 });
await post('product_variants', [
  { product_id: petal.id, label: '15 ml', volume_ml: 15, sku: 'DEMO-WP-15', price_eur: 25, stock_qty: 4, sort_order: 0, is_active: true },
  { product_id: petal.id, label: '70 ml', volume_ml: 70, sku: 'DEMO-WP-70', price_eur: null, stock_qty: 4, sort_order: 1, is_active: true },
]);
await post('product_attributes', { product_id: petal.id, data: { fragrance_family: 'Bloemig', notes: { top: ['citroen'], heart: ['jasmijn'], base: ['witte musk'] } } });
await post('product_images', { product_id: petal.id, url: '/assets/img/massage-hoofd-lg.webp', alt: 'White Petal', is_primary: true });

await mk({ slug: 'rustgids', name: 'De rustgids', category_id: ebooks, price_eur: 14, product_type: 'digital', short_description: 'Een digitale gids voor dagelijkse rust.', sku: 'DEMO-EB' });
await mk({ slug: 'reset-kaars', name: 'Reset geurkaars', category_id: wellness, price_eur: 28, track_stock: true, stock_qty: 6, short_description: 'Sojakaars voor een rustige avond.', sku: 'DEMO-KR' });
console.log('Demo-assortiment aangemaakt (4 producten, 5 varianten) in de testdatabase.');
