/* =============================================================================
   Eluneya — winkelmand (localStorage) en gedeelde shop-functies
   De winkelmand bewaart enkel product-id, variant, aantal en een momentopname (naam, prijs, foto)
   om te tonen. De echte prijs, korting en voorraad worden server-side berekend bij het bestellen
   (place_order in supabase/shop.sql); de prijzen hier zijn dus enkel weergave.
   Zonder localStorage (privévenster, geblokkeerd) werkt de winkelmand tijdens het bezoek in het geheugen.
   Beschikbaar als window.Eluneya.cart en window.Eluneya.shop.
   ========================================================================== */
(function () {
  'use strict';

  var CFG = window.ELUNEYA_CONFIG || {};
  var KEY = 'eluneya:cart:v1';
  var MAX_QTY = 10, MAX_LINES = 20;
  var memory = null;
  var listeners = [];

  /* ---------- opslag ---------- */
  function valid(l) {
    return l && typeof l.id === 'string' && typeof l.name === 'string' && isFinite(l.unit) && l.q >= 1;
  }
  function read() {
    if (memory) { return memory; }
    try {
      var a = JSON.parse(window.localStorage.getItem(KEY) || '[]');
      return Array.isArray(a) ? a.filter(valid) : [];
    } catch (e) { return []; }
  }
  function write(items) {
    memory = items;
    try { window.localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { /* geheugen volstaat */ }
    notify();
  }
  function notify() {
    var c = count();
    var badges = document.querySelectorAll('[data-cart-count]');
    for (var i = 0; i < badges.length; i++) { badges[i].textContent = String(c); badges[i].hidden = c === 0; }
    listeners.forEach(function (fn) { try { fn(items()); } catch (e) { /* luisteraar mag de winkelmand niet breken */ } });
  }

  /* ---------- winkelmand ---------- */
  function items() { return read().map(function (l) { return Object.assign({}, l); }); }
  function same(l, id, v) { return l.id === id && (l.v || null) === (v || null); }
  function clamp(q) { q = Math.round(Number(q)); return isFinite(q) ? Math.max(1, Math.min(MAX_QTY, q)) : 1; }

  function add(item, qty) {
    var list = read().slice();
    var existing = list.filter(function (l) { return same(l, item.id, item.v); })[0];
    if (existing) { existing.q = clamp(existing.q + clamp(qty || 1)); }
    else {
      if (list.length >= MAX_LINES) { return false; }
      list.push({ id: item.id, v: item.v || null, q: clamp(qty || 1), name: item.name, slug: item.slug, cat: item.cat,
                  img: item.img || null, variant: item.variant || null, content: item.content || null,
                  unit: Number(item.unit), list: Number(item.list != null ? item.list : item.unit) });
    }
    write(list);
    return true;
  }
  function setQty(id, v, q) {
    write(read().map(function (l) { if (same(l, id, v)) { l.q = clamp(q); } return l; }));
  }
  function remove(id, v) { write(read().filter(function (l) { return !same(l, id, v); })); }
  function clear() { write([]); }
  function count() { return read().reduce(function (s, l) { return s + l.q; }, 0); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function totals() {
    var subtotal = 0, total = 0;
    read().forEach(function (l) { subtotal += l.list * l.q; total += l.unit * l.q; });
    return { subtotal: round2(subtotal), discount: round2(subtotal - total), total: round2(total) };
  }
  function subscribe(fn) { listeners.push(fn); }
  function update(id, v, patch) { // prijs/voorraad verversen na live controle
    write(read().map(function (l) { if (same(l, id, v)) { Object.assign(l, patch); } return l; }));
  }

  /* ---------- gedeelde hulp voor de shop ---------- */
  function fmt(n) { return '€ ' + Number(n).toFixed(2).replace('.', ','); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function saleActive(p, now) {
    if (p.sale_price == null) { return false; }
    now = now || Date.now();
    return (!p.sale_starts || now >= Date.parse(p.sale_starts)) && (!p.sale_ends || now <= Date.parse(p.sale_ends));
  }
  function priceNow(p, variant) {
    if (variant && variant.price != null) { return variant.price; }
    return saleActive(p) ? p.sale_price : p.price;
  }
  function listPrice(p, variant) { return variant && variant.price != null ? variant.price : p.price; }
  /* Heeft een product varianten (de database toont publiek enkel actieve), dan bepalen die de voorraad:
     het product is uitverkocht als geen enkele variant nog beschikbaar is. */
  function hasVariants(p) { return !!(p.variants && p.variants.length); }
  function status(p) {
    var a = p.availability;
    if (a === 'out_of_stock') { return { cls: 'out', text: 'Uitverkocht', buy: false }; }
    if (a === 'on_request') { return { cls: 'request', text: 'Enkel op aanvraag', buy: false }; }
    if (hasVariants(p)) {
      if (!p.variants.some(function (v) { return v.available; })) { return { cls: 'out', text: 'Uitverkocht', buy: false }; }
    } else if (!p.available && a === 'in_stock') { return { cls: 'out', text: 'Uitverkocht', buy: false }; }
    if (a === 'preorder') { return { cls: 'preorder', text: 'Voorbestellen', buy: true }; }
    return { cls: 'in', text: 'Op voorraad', buy: true };
  }
  function defaultVariant(p) { // de variant die vooraf gekozen is: de eerste beschikbare
    return (p.variants || []).filter(function (v) { return v.available; })[0] || null;
  }
  /* Prijs op een productkaart: "vanaf" als de varianten verschillende prijzen hebben. */
  function cardPriceHtml(p) {
    if (!hasVariants(p)) { return priceHtml(p, null, false); }
    var shown = p.variants.filter(function (v) { return v.available; });
    if (!shown.length) { shown = p.variants; }
    var prices = shown.map(function (v) { return priceNow(p, v); });
    var min = Math.min.apply(null, prices), max = Math.max.apply(null, prices);
    if (min === max) { return priceHtml(p, shown[0], false); }
    return '<p class="p-price"><span class="p-from">vanaf</span> <strong class="p-now">' + fmt(min) + '</strong></p>';
  }
  function variantsHtml(p) { // keuze van de inhoud op de productpagina
    if (!hasVariants(p)) { return ''; }
    var def = defaultVariant(p);
    return '<fieldset class="variants" data-variants><legend>Inhoud</legend><div class="variant-grid">' + p.variants.map(function (v) {
      return '<label class="variant-opt' + (v.available ? '' : ' is-out') + '"><input type="radio" name="variant" value="' + esc(v.id) + '"' +
        (def && def.id === v.id ? ' checked' : '') + (v.available ? '' : ' disabled') + '><span class="v-name">' + esc(v.label) + '</span><span class="v-price">' +
        (v.available ? fmt(priceNow(p, v)) : 'Uitverkocht') + '</span></label>';
    }).join('') + '</div></fieldset>';
  }
  function priceHtml(p, variant, big) {
    var now = priceNow(p, variant), cls = 'p-price' + (big ? ' big' : '');
    var variantPrice = variant && variant.price != null;
    if (!variantPrice && saleActive(p)) {
      return '<p class="' + cls + '"><s class="p-was"><span class="visually-hidden">Normale prijs </span>' + fmt(p.price) + '</s> <strong class="p-now"><span class="visually-hidden">Nu </span>' + fmt(now) + '</strong></p>';
    }
    if (!variantPrice && p.compare_at) {
      return '<p class="' + cls + '"><s class="p-was"><span class="visually-hidden">Oude prijs </span>' + fmt(p.compare_at) + '</s> <strong class="p-now">' + fmt(now) + '</strong></p>';
    }
    return '<p class="' + cls + '"><strong class="p-now">' + fmt(now) + '</strong></p>';
  }

  /* ---------- Supabase (enkel lezen, publieke sleutel) ---------- */
  var live = /^https:\/\/[^\s]+$/.test(CFG.supabaseUrl || '') && !!CFG.supabaseKey;
  function rest(query) {
    if (!live) { return Promise.reject(new Error('niet gekoppeld')); }
    var headers = { apikey: CFG.supabaseKey, Accept: 'application/json' };
    if (/^eyJ/.test(CFG.supabaseKey)) { headers.Authorization = 'Bearer ' + CFG.supabaseKey; }
    return fetch(CFG.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/' + query, { headers: headers }).then(function (r) {
      if (!r.ok) { throw new Error('http ' + r.status); }
      return r.json();
    });
  }
  var SELECT = 'id,slug,name,short_description,description,ingredients,content_label,product_type,sku,price_eur,compare_at_price_eur,' +
    'sale_price_eur,sale_starts_at,sale_ends_at,availability,is_available,is_featured,sort_order,created_at,' +
    'product_categories(slug,name),brands(name),product_images(url,alt,sort_order,is_primary),product_attributes(data),' +
    'product_variants(id,label,volume_ml,sku,price_eur,sort_order,is_available)';
  function normalise(r) {
    var attrs = r.product_attributes;
    attrs = Array.isArray(attrs) ? (attrs[0] && attrs[0].data) : (attrs && attrs.data);
    var imgs = (r.product_images || []).slice().sort(function (a, b) { return (b.is_primary - a.is_primary) || (a.sort_order - b.sort_order); });
    return {
      id: r.id, slug: r.slug, category: r.product_categories && r.product_categories.slug,
      categoryName: r.product_categories && r.product_categories.name, brand: r.brands && r.brands.name,
      name: r.name, short: r.short_description, description: r.description, ingredients: r.ingredients, content: r.content_label,
      type: r.product_type, sku: r.sku, price: Number(r.price_eur),
      compare_at: r.compare_at_price_eur != null ? Number(r.compare_at_price_eur) : null,
      sale_price: r.sale_price_eur != null ? Number(r.sale_price_eur) : null, sale_starts: r.sale_starts_at, sale_ends: r.sale_ends_at,
      availability: r.availability, available: !!r.is_available, featured: !!r.is_featured, sort: r.sort_order, created: r.created_at,
      images: imgs.map(function (i) { return { url: i.url, alt: i.alt }; }), attributes: attrs || {},
      variants: (r.product_variants || []).slice().sort(function (a, b) { return a.sort_order - b.sort_order; }).map(function (v) {
        return { id: v.id, label: v.label, volume: v.volume_ml != null ? Number(v.volume_ml) : null, sku: v.sku, price: v.price_eur != null ? Number(v.price_eur) : null, available: !!v.is_available };
      })
    };
  }
  function fetchProducts(filter) { // filter: bv. "id=in.(a,b)" of "slug=eq.x"; zonder = alles
    return rest('products?select=' + SELECT + (filter ? '&' + filter : '') + '&order=sort_order').then(function (rows) { return rows.map(normalise); });
  }

  window.Eluneya = window.Eluneya || {};
  window.Eluneya.cart = { items: items, add: add, setQty: setQty, remove: remove, clear: clear, count: count, totals: totals,
                          subscribe: subscribe, update: update, MAX_QTY: MAX_QTY };
  window.Eluneya.shop = { fmt: fmt, esc: esc, priceNow: priceNow, listPrice: listPrice, saleActive: saleActive, status: status,
                          priceHtml: priceHtml, cardPriceHtml: cardPriceHtml, variantsHtml: variantsHtml, hasVariants: hasVariants,
                          defaultVariant: defaultVariant, fetchProducts: fetchProducts, live: live, rest: rest };

  window.addEventListener('storage', function (e) { if (e.key === KEY) { memory = null; notify(); } });
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', notify); } else { notify(); }
})();
