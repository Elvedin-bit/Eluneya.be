/* =============================================================================
   Eluneya — productpagina: galerij, aantal, variant, toevoegen aan winkelmand,
   en live controle van prijs en voorraad (Supabase, enkel lezen).
   De pagina zelf is statisch (SEO); dit script maakt ze interactief.

   Generieke pagina: een product dat net is toegevoegd heeft nog geen statische pagina (die komt bij de
   volgende publicatie van de website). Netlify toont dan shop/product.html; die haalt het product live op
   en bouwt dezelfde pagina op (niet geïndexeerd).
   ========================================================================== */
(function () {
  'use strict';

  var W = window.Eluneya;
  if (!W) { return; }
  var SHOP = W.shop, CART = W.cart, esc = SHOP.esc, fmt = SHOP.fmt;

  var dyn = document.querySelector('[data-product-dynamic]');
  if (dyn) { loadDynamic(dyn); return; }
  var page = document.querySelector('[data-product-id]');
  if (page) {
    var pid = page.getAttribute('data-product-id');
    init(page, ((window.ELUNEYA_CATALOG || {}).products || []).filter(function (p) { return p.id === pid; })[0]);
  }

  /* ---------- generieke pagina ---------- */
  function loadDynamic(box) {
    var m = window.location.pathname.match(/\/shop\/([^/]+)\/([^/]+)\/?$/);
    var slug = m && m[2] !== 'product.html' ? decodeURIComponent(m[2]) : null;
    var fail = function () {
      box.innerHTML = '<div class="container"><div class="cart-empty"><h1 class="h-sub">Dit product vonden we niet</h1><p>Het is niet (meer) beschikbaar.</p><a class="btn btn-dark" href="/shop/">Naar de shop</a></div></div>';
    };
    if (!slug || !SHOP.live) { return fail(); }
    SHOP.fetchProducts('slug=eq.' + encodeURIComponent(slug)).then(function (rows) {
      var p = rows[0];
      if (!p) { return fail(); }
      document.title = p.name + ' | Eluneya';
      box.innerHTML = pageHtml(p);
      box.removeAttribute('data-product-dynamic');
      box.setAttribute('data-product-id', p.id);
      init(box, p);
    }).catch(fail);
  }

  function pageHtml(p) {
    var a = p.attributes || {}, n = a.notes || {}, st = SHOP.status(p), cat = p.categoryName || 'Shop';
    var tiers = [['top', 'Topnoten', 'De eerste indruk, de eerste minuten.'], ['heart', 'Hartnoten', 'Het karakter van de geur.'], ['base', 'Basisnoten', 'Blijft uren op de huid.']]
      .filter(function (t) { return n[t[0]] && n[t[0]].length; });
    var notes = tiers.length ? '<div class="notes">' + tiers.map(function (t) {
      return '<div class="note-tier"><h3>' + t[1] + '</h3><p class="note-sub">' + t[2] + '</p><ul class="chips-static">' +
        n[t[0]].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    }).join('') + '</div>' : '';
    var line = tiers.length ? '<p class="notes-line">' + tiers.map(function (t) {
      return '<span><b>' + t[1].replace('noten', '') + '</b> ' + esc(n[t[0]].join(', ')) + '</span>';
    }).join('') + '</p>' : '';
    var im = p.images && p.images[0];
    var media = im
      ? '<div id="gallery-main" class="p-media ratio-portrait"><img src="' + esc(im.url) + '" alt="' + esc(im.alt || p.name) + '" width="800" height="1000" fetchpriority="high"></div>'
      : '<div class="p-media p-noimg" aria-hidden="true"><span>' + esc(p.name.charAt(0)) + '</span></div>';
    var thumbs = p.images && p.images.length > 1 ? '<div class="gallery-thumbs" role="group" aria-label="Meer foto’s">' + p.images.map(function (i, k) {
      return '<button type="button" data-src="' + esc(i.url) + '" data-alt="' + esc(i.alt || p.name) + '" aria-label="Foto ' + (k + 1) + '"' + (k === 0 ? ' aria-current="true"' : '') +
        '><img src="' + esc(i.url) + '" alt="" width="96" height="120" loading="lazy"></button>';
    }).join('') + '</div>' : '';
    var variants = (p.variants || []).length ? '<div class="field"><label for="p-variant">Inhoud</label><select class="select" id="p-variant" data-variant>' + p.variants.map(function (v) {
      return '<option value="' + esc(v.id) + '"' + (v.available ? '' : ' disabled') + '>' + esc(v.label) + (v.price != null ? ' — ' + fmt(v.price) : '') + (v.available ? '' : ' (uitverkocht)') + '</option>';
    }).join('') + '</select></div>' : '';
    var buy = st.buy
      ? '<div class="buy" data-buy>' + variants + '<div class="buy-row"><div class="qty" role="group" aria-label="Aantal"><button type="button" data-qty-minus aria-label="Minder">−</button>' +
        '<input type="number" id="p-qty" value="1" min="1" max="10" inputmode="numeric" aria-label="Aantal"><button type="button" data-qty-plus aria-label="Meer">+</button></div>' +
        '<button class="btn btn-dark buy-btn" type="button" data-add>Toevoegen aan winkelmand</button></div><p class="buy-msg" role="status" aria-live="polite" data-msg></p></div>'
      : '<div class="buy"><p class="buy-msg is-info">' + (st.cls === 'request' ? 'Dit product is enkel op aanvraag beschikbaar.' : 'Momenteel uitverkocht.') + '</p></div>';
    var facts = [['Inhoud', p.content], ['Geurfamilie', a.fragrance_family], ['Concentratie', a.concentration], ['Merk', p.brand], ['Productcode', p.sku], ['Categorie', cat]]
      .filter(function (f) { return f[1]; }).map(function (f) { return '<div><dt>' + f[0] + '</dt><dd>' + esc(f[1]) + '</dd></div>'; }).join('');
    var secs = [];
    if (notes) { secs.push(['Geurprofiel', notes]); }
    if (p.description) { secs.push(['Beschrijving', String(p.description).split('\n\n').map(function (x) { return '<p>' + esc(x) + '</p>'; }).join('')]); }
    secs.push(['Details', '<dl class="facts">' + facts + '</dl>']);
    if (p.ingredients) { secs.push(['Ingrediënten', '<p>' + esc(p.ingredients) + '</p>']); }
    secs.push(['Bestellen &amp; levering', '<p>Je plaatst een bestelaanvraag. Aida bevestigt ze, en spreekt betaling en afhalen of verzenden met je af via WhatsApp of e-mail. Prijzen zijn inclusief btw.</p>']);
    return '<div class="container"><nav class="crumbs" aria-label="Kruimelpad"><a href="/shop/">Shop</a><span aria-hidden="true">/</span><a href="/shop/' + esc(p.category) + '/">' + esc(cat) +
      '</a><span aria-hidden="true">/</span><span aria-current="page">' + esc(p.name) + '</span></nav><div class="pdp"><div class="pdp-gallery">' + media + thumbs + '</div><div class="pdp-info">' +
      '<p class="eyebrow">' + esc(p.brand || cat) + '</p><h1 class="h-display pdp-title" id="page-title">' + esc(p.name) + '</h1>' +
      (p.content ? '<p class="pdp-content">' + esc(p.content) + (a.fragrance_family ? ' · ' + esc(a.fragrance_family) : '') + '</p>' : '') +
      '<div class="pdp-price" data-price-block>' + SHOP.priceHtml(p, null, true) + '</div><p class="pdp-status is-' + st.cls + '" data-status><span class="dot" aria-hidden="true"></span>' + st.text + '</p>' +
      (p.short ? '<p class="pdp-short">' + esc(p.short) + '</p>' : '') + line + buy + '</div></div><div class="pdp-more">' +
      secs.map(function (s, i) { return '<details class="acc"' + (i === 0 ? ' open' : '') + '><summary>' + s[0] + '</summary><div class="acc-body">' + s[1] + '</div></details>'; }).join('') +
      '</div></div>';
  }

  /* ---------- interactie ---------- */
  function init(root, product) {
    if (!product) { return; }
    var id = root.getAttribute('data-product-id');
    var priceBlock = root.querySelector('[data-price-block]');
    var statusEl = root.querySelector('[data-status]');
    var buy = root.querySelector('[data-buy]');
    var qty = document.getElementById('p-qty');
    var variantSel = document.getElementById('p-variant');
    var msg = root.querySelector('[data-msg]');
    var addBtn = root.querySelector('[data-add]');
    var toast;

    function variant() {
      if (!variantSel) { return null; }
      return (product.variants || []).filter(function (v) { return v.id === variantSel.value; })[0] || null;
    }
    function say(text, cls) { if (msg) { msg.textContent = text || ''; msg.className = 'buy-msg' + (cls ? ' ' + cls : ''); } }

    /* prijs en status */
    function paint() {
      var v = variant();
      if (priceBlock) { priceBlock.innerHTML = SHOP.priceHtml(product, v, true); }
      var st = SHOP.status(product);
      if (statusEl) {
        statusEl.className = 'pdp-status is-' + st.cls;
        statusEl.innerHTML = '<span class="dot" aria-hidden="true"></span>' + st.text;
      }
      if (buy && addBtn) {
        var blocked = !st.buy || (v && !v.available);
        addBtn.disabled = blocked;
        addBtn.setAttribute('aria-disabled', String(blocked));
        if (blocked) { say(v && !v.available ? 'Deze inhoud is momenteel uitverkocht.' : st.text, 'is-info'); }
        else if (msg && /uitverkocht|aanvraag/i.test(msg.textContent)) { say(''); }
      }
    }
    if (variantSel) {
      var firstOk = (product.variants || []).filter(function (v) { return v.available; })[0];
      if (firstOk) { variantSel.value = firstOk.id; }
      variantSel.addEventListener('change', function () { say(''); paint(); });
    }

    /* galerij */
    var thumbs = root.querySelector('.gallery-thumbs');
    var main = document.getElementById('gallery-main');
    if (thumbs && main) {
      thumbs.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-src]');
        var img = main.querySelector('img');
        if (!b || !img) { return; }
        img.src = b.getAttribute('data-src'); img.alt = b.getAttribute('data-alt') || '';
        thumbs.querySelectorAll('button').forEach(function (x) { x.removeAttribute('aria-current'); });
        b.setAttribute('aria-current', 'true');
      });
    }

    /* aantal */
    function setQty(n) { qty.value = String(Math.max(1, Math.min(CART.MAX_QTY, Math.round(Number(n)) || 1))); }
    if (qty) {
      root.querySelector('[data-qty-minus]').addEventListener('click', function () { setQty(Number(qty.value) - 1); });
      root.querySelector('[data-qty-plus]').addEventListener('click', function () { setQty(Number(qty.value) + 1); });
      qty.addEventListener('change', function () { setQty(qty.value); });
    }

    /* toevoegen */
    function showToast() {
      if (toast) { toast.remove(); }
      toast = document.createElement('div');
      toast.className = 'cart-toast'; toast.setAttribute('role', 'status');
      toast.innerHTML = '<span>Toegevoegd aan je winkelmand</span><a href="/winkelmand.html">Bekijk</a>';
      document.body.appendChild(toast);
      setTimeout(function () { if (toast) { toast.remove(); toast = null; } }, 5000);
    }
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var v = variant(), st = SHOP.status(product);
        if (!st.buy || (v && !v.available)) { return; }
        var im = product.images && product.images[0];
        var ok = CART.add({
          id: product.id, v: v ? v.id : null, name: product.name, slug: product.slug, cat: product.category,
          img: im ? im.url : null, variant: v ? v.label : null, content: product.content,
          unit: SHOP.priceNow(product, v), list: SHOP.listPrice(product, v)
        }, qty ? Number(qty.value) : 1);
        if (!ok) { say('Je winkelmand is vol (max. 20 verschillende producten).', 'is-error'); return; }
        say('');
        showToast();
      });
    }

    paint();

    /* live prijs en voorraad */
    if (SHOP.live && !root.hasAttribute('data-live-done')) {
      SHOP.fetchProducts('id=eq.' + encodeURIComponent(id)).then(function (rows) {
        if (!rows[0]) { return; }
        var keep = variantSel && variantSel.value;
        product = Object.assign({}, product, rows[0], { images: product.images.length ? product.images : rows[0].images });
        if (variantSel && keep) { variantSel.value = keep; }
        paint();
      }).catch(function () { /* statische gegevens blijven staan */ });
    }
  }
})();
