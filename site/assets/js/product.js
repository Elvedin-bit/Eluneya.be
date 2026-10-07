/* =============================================================================
   Eluneya — productpagina: galerij, aantal, variant, toevoegen aan winkelmand,
   en live controle van prijs en voorraad (Supabase, enkel lezen).
   De pagina zelf is statisch (SEO); dit script maakt ze interactief.
   ========================================================================== */
(function () {
  'use strict';

  var root = document.querySelector('[data-product-id]');
  var W = window.Eluneya;
  if (!root || !W) { return; }
  var SHOP = W.shop, CART = W.cart;

  var id = root.getAttribute('data-product-id');
  var catalog = (window.ELUNEYA_CATALOG || {}).products || [];
  var product = catalog.filter(function (p) { return p.id === id; })[0];
  if (!product) { return; }

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

  /* ---------- weergave van prijs/status ---------- */
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
      if (blocked) { say(v && !v.available ? 'Deze inhoud is momenteel uitverkocht.' : st.text, 'is-info'); } else if (msg && /uitverkocht|aanvraag/i.test(msg.textContent)) { say(''); }
    }
  }
  if (variantSel) {
    var firstOk = (product.variants || []).filter(function (v) { return v.available; })[0];
    if (firstOk) { variantSel.value = firstOk.id; }
    variantSel.addEventListener('change', function () { say(''); paint(); });
  }

  /* ---------- galerij ---------- */
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

  /* ---------- aantal ---------- */
  function setQty(n) { qty.value = String(Math.max(1, Math.min(CART.MAX_QTY, Math.round(Number(n)) || 1))); }
  if (qty) {
    root.querySelector('[data-qty-minus]').addEventListener('click', function () { setQty(Number(qty.value) - 1); });
    root.querySelector('[data-qty-plus]').addEventListener('click', function () { setQty(Number(qty.value) + 1); });
    qty.addEventListener('change', function () { setQty(qty.value); });
  }

  /* ---------- toevoegen ---------- */
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

  /* ---------- live prijs en voorraad ---------- */
  if (SHOP.live) {
    SHOP.fetchProducts('id=eq.' + encodeURIComponent(id)).then(function (rows) {
      if (!rows[0]) { return; }
      var keepVariant = variantSel && variantSel.value;
      product = Object.assign({}, product, rows[0], { images: product.images.length ? product.images : rows[0].images });
      if (variantSel && keepVariant) { variantSel.value = keepVariant; }
      paint();
    }).catch(function () { /* statische gegevens blijven staan */ });
  }
})();
