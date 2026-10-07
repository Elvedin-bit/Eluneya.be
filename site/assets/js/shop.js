/* =============================================================================
   Eluneya — shop-overzicht: filteren, sorteren, zoeken
   Start met de catalogus uit de pagina (catalog.js, gelijk aan de statische kaarten) en ververst daarna
   prijzen en voorraad live uit Supabase. Mislukt dat, dan blijft de statische catalogus gewoon werken.
   ========================================================================== */
(function () {
  'use strict';

  var root = document.querySelector('[data-shop-mode]');
  var SHOP = window.Eluneya && window.Eluneya.shop;
  if (!root || !SHOP) { return; }

  var mode = root.getAttribute('data-shop-mode');
  var data = ((window.ELUNEYA_CATALOG || {}).products || []).slice();
  var esc = SHOP.esc, fmt = SHOP.fmt;
  var results = document.getElementById('shop-results');
  var none = document.getElementById('shop-none');
  var countEl = document.getElementById('shop-count');
  var ui = {
    q: document.getElementById('shop-search'), sort: document.getElementById('shop-sort'),
    brand: document.getElementById('shop-brand'), family: document.getElementById('shop-family'),
    instock: document.getElementById('shop-instock')
  };
  var state = { cat: root.getAttribute('data-shop-cat') || '', q: '', sort: 'featured', brand: '', family: '', instock: false };

  /* ---------- toestand uit de URL ---------- */
  var params = new URLSearchParams(window.location.search);
  if (mode === 'index' && params.get('cat')) { state.cat = params.get('cat'); }
  ['q', 'sort', 'brand', 'family'].forEach(function (k) { if (params.get(k)) { state[k] = params.get(k); } });
  state.instock = params.get('instock') === '1';
  Object.keys(ui).forEach(function (k) {
    if (!ui[k]) { return; }
    if (k === 'instock') { ui[k].checked = state.instock; } else { ui[k].value = state[k]; }
  });
  if (ui.sort && ui.sort.value !== state.sort) { state.sort = 'featured'; ui.sort.value = 'featured'; }

  function syncUrl() {
    var p = new URLSearchParams();
    if (mode === 'index' && state.cat) { p.set('cat', state.cat); }
    if (state.q) { p.set('q', state.q); }
    if (state.sort !== 'featured') { p.set('sort', state.sort); }
    if (state.brand) { p.set('brand', state.brand); }
    if (state.family) { p.set('family', state.family); }
    if (state.instock) { p.set('instock', '1'); }
    var s = p.toString();
    try { window.history.replaceState(null, '', window.location.pathname + (s ? '?' + s : '')); } catch (e) { /* niet erg */ }
  }

  /* ---------- kaart ---------- */
  function badges(p) {
    var out = '', st = SHOP.status(p);
    if (SHOP.saleActive(p)) { out += '<span class="p-badge sale">−' + Math.round((1 - p.sale_price / p.price) * 100) + '%</span>'; }
    if (st.cls === 'out' || st.cls === 'request' || st.cls === 'preorder') { out += '<span class="p-badge ' + st.cls + '">' + st.text + '</span>'; }
    return out ? '<span class="p-badges">' + out + '</span>' : '';
  }
  function card(p, i) {
    var attrs = p.attributes || {}, st = SHOP.status(p);
    var meta = [p.content, attrs.fragrance_family].filter(Boolean).join(' · ');
    var im = p.images && p.images[0];
    var media = im
      ? '<div class="p-media ratio-portrait"><img src="' + esc(im.url) + '" alt="' + esc(im.alt || p.name) + '" width="800" height="1000" loading="lazy" decoding="async"></div>'
      : '<div class="p-media p-noimg" aria-hidden="true"><span>' + esc(p.name.charAt(0)) + '</span></div>';
    return '<article class="p-card reveal is-visible" data-in="' + (st.buy ? 1 : 0) + '">' +
      '<a class="p-card-link" href="/shop/' + esc(p.category) + '/' + esc(p.slug) + '/"><div class="p-media-wrap">' + media + badges(p) + '</div>' +
      '<div class="p-card-body">' + (p.brand ? '<p class="p-brand">' + esc(p.brand) + '</p>' : '') +
      '<h3 class="p-name">' + esc(p.name) + '</h3>' + (meta ? '<p class="p-meta">' + esc(meta) + '</p>' : '') +
      SHOP.priceHtml(p, null, false) + '</div></a></article>';
  }

  /* ---------- filteren en sorteren ---------- */
  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = data.filter(function (p) {
      var attrs = p.attributes || {};
      if (state.cat && p.category !== state.cat) { return false; }
      if (state.brand && p.brand !== state.brand) { return false; }
      if (state.family && attrs.fragrance_family !== state.family) { return false; }
      if (state.instock && !SHOP.status(p).buy) { return false; }
      if (q) {
        var notes = attrs.notes ? [].concat(attrs.notes.top || [], attrs.notes.heart || [], attrs.notes.base || []).join(' ') : '';
        var hay = [p.name, p.brand, p.short, p.content, attrs.fragrance_family, notes].join(' ').toLowerCase();
        if (q.split(/\s+/).some(function (w) { return hay.indexOf(w) < 0; })) { return false; }
      }
      return true;
    });
    var by = {
      featured: function (a, b) { return (b.featured - a.featured) || (a.sort - b.sort) || a.name.localeCompare(b.name, 'nl'); },
      'new': function (a, b) { return String(b.created || '').localeCompare(String(a.created || '')); },
      'price-asc': function (a, b) { return SHOP.priceNow(a) - SHOP.priceNow(b); },
      'price-desc': function (a, b) { return SHOP.priceNow(b) - SHOP.priceNow(a); },
      name: function (a, b) { return a.name.localeCompare(b.name, 'nl'); }
    };
    return list.sort(by[state.sort] || by.featured);
  }

  function render() {
    var list = filtered();
    var grid = '<div class="p-grid" id="shop-grid">' + list.map(card).join('') + '</div>';
    results.innerHTML = list.length ? grid : '';
    none.hidden = list.length > 0;
    countEl.textContent = list.length === 1 ? '1 product' : list.length + ' producten';
    var chips = document.querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) {
      var on = chips[i].getAttribute('data-cat') === state.cat;
      if (on) { chips[i].setAttribute('aria-current', 'true'); } else { chips[i].removeAttribute('aria-current'); }
    }
    syncUrl();
  }

  /* ---------- bediening ---------- */
  var timer;
  if (ui.q) { ui.q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { state.q = ui.q.value; render(); }, 120); }); }
  ['sort', 'brand', 'family'].forEach(function (k) {
    if (ui[k]) { ui[k].addEventListener('change', function () { state[k] = ui[k].value; render(); }); }
  });
  if (ui.instock) { ui.instock.addEventListener('change', function () { state.instock = ui.instock.checked; render(); }); }
  if (mode === 'index') { // categorie wisselen zonder herladen; elke chip blijft ook een gewone link
    document.querySelector('.chips').addEventListener('click', function (e) {
      var a = e.target.closest('a.chip');
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey) { return; }
      e.preventDefault(); state.cat = a.getAttribute('data-cat'); render();
    });
  }

  render();

  /* ---------- live prijzen en voorraad ---------- */
  if (SHOP.live) {
    SHOP.fetchProducts().then(function (rows) {
      if (!rows.length) { return; }
      data = rows.filter(function (p) { return p.category; });
      render();
    }).catch(function () { /* statische catalogus blijft staan */ });
  }
})();
