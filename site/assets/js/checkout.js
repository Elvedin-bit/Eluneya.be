/* =============================================================================
   Eluneya — winkelmandpagina en bestelaanvraag
   * toont de winkelmand (localStorage), met aantallen wijzigen en verwijderen;
   * controleert live prijzen en beschikbaarheid (Supabase, enkel lezen);
   * verstuurt de bestelaanvraag via de databasefunctie place_order (supabase/shop.sql). Die berekent
     prijzen, voorraad en totaal server-side; wat hier getoond wordt is enkel weergave.
   Er is bewust geen betaling: Aida bevestigt de aanvraag en spreekt betaling en levering af.
   ========================================================================== */
(function () {
  'use strict';

  var W = window.Eluneya;
  var root = document.getElementById('cart-root');
  if (!W || !root) { return; }
  var CART = W.cart, SHOP = W.shop, esc = SHOP.esc, fmt = SHOP.fmt;
  var CFG = window.ELUNEYA_CONFIG || {};
  var DATA = window.ELUNEYA_DATA || { contact: {} };
  var WA = (DATA.contact && DATA.contact.whatsapp) || '';
  var state = { notes: {}, blocked: false, done: null, busy: false, form: {} };

  var ERRORS = {
    lege_bestelling: 'Je winkelmand is leeg.',
    akkoord_vereist: 'Vink aan dat je akkoord gaat met de algemene voorwaarden.',
    ongeldige_gegevens: 'Controleer je gegevens (naam en e-mailadres).',
    adres_vereist: 'Vul je volledige adres in voor verzending.',
    ongeldig_aantal: 'Kies een aantal tussen 1 en 10 per product.',
    te_veel_bestellingen: 'Je hebt al meerdere openstaande aanvragen. Aida neemt snel contact met je op; heb je haast, stuur dan een bericht via WhatsApp.',
    product_niet_beschikbaar: 'Een product in je winkelmand is niet meer beschikbaar.',
    onvoldoende_voorraad: 'Er is niet genoeg voorraad van een product in je winkelmand.',
    kies_variant: 'Kies eerst de gewenste inhoud van een product.'
  };

  function waLink(text) { return 'https://wa.me/' + WA + '?text=' + encodeURIComponent(text); }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }

  /* ---------- live controle van prijzen en beschikbaarheid ---------- */
  function refreshLive() {
    var ids = CART.items().map(function (l) { return l.id; }).filter(function (x, i, a) { return a.indexOf(x) === i; });
    if (!SHOP.live || !ids.length) { return Promise.resolve(); }
    return SHOP.fetchProducts('id=in.(' + ids.join(',') + ')').then(function (rows) {
      var byId = {}; rows.forEach(function (p) { byId[p.id] = p; });
      state.notes = {}; state.blocked = false;
      CART.items().forEach(function (l) {
        var key = l.id + '|' + (l.v || ''), p = byId[l.id];
        if (!p) { state.notes[key] = 'Dit product is niet meer beschikbaar.'; state.blocked = true; return; }
        var v = (p.variants || []).filter(function (x) { return x.id === l.v; })[0] || null;
        if (!SHOP.status(p).buy || (l.v && (!v || !v.available))) { state.notes[key] = 'Momenteel niet beschikbaar.'; state.blocked = true; return; }
        var unit = SHOP.priceNow(p, v), list = SHOP.listPrice(p, v);
        if (Math.abs(unit - l.unit) > 0.004) {
          state.notes[key] = 'De prijs is aangepast naar ' + fmt(unit) + '.';
          CART.update(l.id, l.v, { unit: unit, list: list });
        } else if (Math.abs(list - l.list) > 0.004) { CART.update(l.id, l.v, { list: list }); }
      });
    }).catch(function () { /* geen verbinding: toon de bewaarde prijzen; de server controleert alsnog */ });
  }

  /* ---------- weergave ---------- */
  function lineHtml(l) {
    var key = l.id + '|' + (l.v || '');
    var media = l.img
      ? '<div class="p-media ratio-portrait"><img src="' + esc(l.img) + '" alt="" width="96" height="120" loading="lazy"></div>'
      : '<div class="p-media p-noimg" aria-hidden="true"><span>' + esc(l.name.charAt(0)) + '</span></div>';
    var meta = [l.variant || l.content, l.unit < l.list ? '<s>' + fmt(l.list) + '</s> ' + fmt(l.unit) + ' per stuk' : fmt(l.unit) + ' per stuk'].filter(Boolean).join(' · ');
    return '<li class="cart-line" data-id="' + esc(l.id) + '" data-v="' + esc(l.v || '') + '">' + media +
      '<div><h3><a href="/shop/' + esc(l.cat) + '/' + esc(l.slug) + '/">' + esc(l.name) + '</a></h3><p class="line-meta">' + meta + '</p>' +
      (state.notes[key] ? '<p class="line-note" role="alert">' + esc(state.notes[key]) + '</p>' : '') +
      '<div class="line-actions"><div class="qty" role="group" aria-label="Aantal van ' + esc(l.name) + '">' +
      '<button type="button" data-act="minus" aria-label="Minder">−</button><input type="number" min="1" max="' + CART.MAX_QTY + '" value="' + l.q + '" inputmode="numeric" data-act="qty" aria-label="Aantal">' +
      '<button type="button" data-act="plus" aria-label="Meer">+</button></div>' +
      '<button type="button" class="remove" data-act="remove">Verwijderen</button></div></div>' +
      '<p class="line-total">' + fmt(l.unit * l.q) + '</p></li>';
  }

  function summaryHtml(t) {
    return '<aside class="cart-summary" aria-label="Overzicht"><h2>Overzicht</h2>' +
      '<div class="sum-row"><span>Subtotaal</span><span>' + fmt(t.subtotal) + '</span></div>' +
      (t.discount > 0 ? '<div class="sum-row discount"><span>Korting</span><span>− ' + fmt(t.discount) + '</span></div>' : '') +
      '<div class="sum-row"><span>Verzending</span><span>In overleg</span></div>' +
      '<div class="sum-row total"><span>Totaal</span><span>' + fmt(t.total) + '</span></div>' +
      '<p class="fineprint">Prijzen zijn inclusief btw. Je plaatst een bestelaanvraag: je betaalt nog niets. Aida bevestigt ze en spreekt betaling en afhalen of verzenden met je af.</p>' +
      '<button class="btn btn-dark" type="submit" form="checkout-form" id="order-btn" style="width:100%;margin-top:14px"' + (state.blocked ? ' disabled' : '') + '>Bestelaanvraag versturen</button>' +
      '<a class="btn btn-outline" style="width:100%;margin-top:10px" target="_blank" rel="noopener" href="' + esc(waLink(whatsappText(null))) + '">Liever via WhatsApp</a></aside>';
  }

  function whatsappText(orderNo) {
    var lines = CART.items().map(function (l) { return l.q + '× ' + l.name + (l.variant ? ' (' + l.variant + ')' : '') + ' — ' + fmt(l.unit * l.q); });
    return 'Hallo Aida, ' + (orderNo ? 'ik heb een bestelaanvraag geplaatst (' + orderNo + '):' : 'ik wil graag bestellen:') + '\n' + lines.join('\n') + '\nTotaal: ' + fmt(CART.totals().total);
  }

  function formHtml() {
    var f = state.form;
    function v(k) { return esc(f[k] || ''); }
    var ship = f.delivery === 'verzenden';
    return '<div class="checkout-card"><form class="booking-card" id="checkout-form" novalidate>' +
      '<h2 class="h-sub" style="margin-bottom:18px">Jouw gegevens</h2>' +
      '<div class="form-row"><div class="field"><label for="c-name">Naam *</label><input class="input" id="c-name" name="name" autocomplete="name" maxlength="120" value="' + v('name') + '" required></div>' +
      '<div class="field"><label for="c-email">E-mailadres *</label><input class="input" id="c-email" name="email" type="email" autocomplete="email" maxlength="200" value="' + v('email') + '" required></div></div>' +
      '<div class="field"><label for="c-phone">Telefoon <span class="hint">(optioneel)</span></label><input class="input" id="c-phone" name="phone" type="tel" autocomplete="tel" maxlength="40" value="' + v('phone') + '"></div>' +
      '<fieldset class="booking-step" style="margin-bottom:14px"><legend class="step-title">Levering</legend><div class="delivery-opts">' +
      '<label class="check"><input type="radio" name="delivery" value="afhalen"' + (ship ? '' : ' checked') + '><span>Afhalen in Wevelgem (op afspraak)</span></label>' +
      '<label class="check"><input type="radio" name="delivery" value="verzenden"' + (ship ? ' checked' : '') + '><span>Verzenden (kosten in overleg)</span></label></div>' +
      '<div id="ship-fields"' + (ship ? '' : ' hidden') + '><div class="field"><label for="c-street">Straat en nummer</label><input class="input" id="c-street" name="street" autocomplete="street-address" maxlength="160" value="' + v('street') + '"></div>' +
      '<div class="form-row"><div class="field"><label for="c-postal">Postcode</label><input class="input" id="c-postal" name="postal" autocomplete="postal-code" maxlength="20" value="' + v('postal') + '"></div>' +
      '<div class="field"><label for="c-city">Gemeente</label><input class="input" id="c-city" name="city" autocomplete="address-level2" maxlength="100" value="' + v('city') + '"></div></div></div></fieldset>' +
      '<div class="field"><label for="c-notes">Opmerking <span class="hint">(optioneel)</span></label><textarea class="textarea" id="c-notes" name="notes" maxlength="1000">' + v('notes') + '</textarea></div>' +
      '<div class="hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>' +
      '<label class="check" style="margin-bottom:16px"><input type="checkbox" name="consent" id="c-consent"' + (f.consent ? ' checked' : '') + '><span>Ik ga akkoord met de <a class="text-link" href="/voorwaarden.html" target="_blank" rel="noopener">algemene voorwaarden</a> en de <a class="text-link" href="/privacy.html" target="_blank" rel="noopener">privacyverklaring</a>. *</span></label>' +
      '<p class="form-message is-error" id="checkout-msg" role="alert" hidden></p>' +
      '<p class="fineprint">Je gegevens gebruiken we enkel om je bestelling af te handelen.</p></form></div>';
  }

  function render() {
    if (state.done) { return renderDone(); }
    var items = CART.items();
    if (!items.length) {
      root.innerHTML = '<div class="cart-empty"><h2>Je winkelmand is leeg</h2><p>Ontdek onze parfums en andere producten.</p><a class="btn btn-dark" href="/shop/">Naar de shop</a></div>';
      return;
    }
    var offline = !SHOP.live;
    root.innerHTML = '<div class="cart-layout"><div><ul class="cart-list">' + items.map(lineHtml).join('') + '</ul>' +
      (offline ? '<p class="form-message is-info" style="margin-top:24px">Online bestellen is nog niet beschikbaar. Stuur je bestelling via WhatsApp.</p>' : formHtml()) +
      '</div>' + summaryHtml(CART.totals()) + '</div>';
    if (offline) { var b = document.getElementById('order-btn'); if (b) { b.hidden = true; } }
  }

  function renderDone() {
    var o = state.done;
    root.innerHTML = '<div class="order-done booking-card"><div class="check-icon" style="width:56px;height:56px;margin:0 auto 14px;border-radius:50%;display:grid;place-items:center;background:var(--cream);color:var(--success)">' +
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg></div>' +
      '<h2 class="h-sub">Bedankt voor je bestelaanvraag</h2><p class="order-no">' + esc(o.order_number) + '</p>' +
      '<p>Aida bevestigt je aanvraag zo snel mogelijk en spreekt betaling en ' + (o.delivery === 'verzenden' ? 'verzending' : 'afhalen') + ' met je af. Je hoeft nu nog niets te betalen.</p>' +
      '<ul class="done-lines">' + o.items.map(function (i) { return '<li><span>' + i.qty + '× ' + esc(i.name) + (i.variant ? ' (' + esc(i.variant) + ')' : '') + '</span><span>' + fmt(i.line_total) + '</span></li>'; }).join('') +
      '<li><strong>Totaal</strong><strong>' + fmt(o.total) + '</strong></li></ul>' +
      '<div class="btn-group"><a class="btn btn-dark" target="_blank" rel="noopener" href="' + esc(waLink(o.wa)) + '">Verder afspreken via WhatsApp</a><a class="btn btn-outline" href="/shop/">Verder winkelen</a></div></div>';
    root.scrollIntoView({ block: 'start' });
  }

  /* ---------- bediening ---------- */
  function rememberForm() {
    var f = document.getElementById('checkout-form');
    if (!f) { return; }
    var d = new FormData(f);
    state.form = { name: d.get('name'), email: d.get('email'), phone: d.get('phone'), delivery: d.get('delivery'), street: d.get('street'),
                   postal: d.get('postal'), city: d.get('city'), notes: d.get('notes'), consent: !!d.get('consent') };
  }
  root.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'), line = e.target.closest('.cart-line');
    if (!b || !line) { return; }
    var id = line.getAttribute('data-id'), v = line.getAttribute('data-v') || null;
    var cur = CART.items().filter(function (l) { return l.id === id && (l.v || null) === v; })[0];
    if (!cur) { return; }
    rememberForm();
    if (b.getAttribute('data-act') === 'remove') { CART.remove(id, v); }
    if (b.getAttribute('data-act') === 'minus') { cur.q > 1 ? CART.setQty(id, v, cur.q - 1) : CART.remove(id, v); }
    if (b.getAttribute('data-act') === 'plus') { CART.setQty(id, v, cur.q + 1); }
  });
  root.addEventListener('change', function (e) {
    if (e.target.matches('[data-act="qty"]')) {
      var line = e.target.closest('.cart-line');
      rememberForm();
      CART.setQty(line.getAttribute('data-id'), line.getAttribute('data-v') || null, e.target.value);
    }
    if (e.target.name === 'delivery') { document.getElementById('ship-fields').hidden = e.target.value !== 'verzenden'; }
  });
  CART.subscribe(function () { if (!state.done && !state.busy) { render(); } });

  function msg(text) { var m = document.getElementById('checkout-msg'); if (m) { m.textContent = text || ''; m.hidden = !text; if (text) { m.scrollIntoView({ block: 'center', behavior: 'smooth' }); } } }

  function submit(form) {
    var d = new FormData(form), name = String(d.get('name') || '').trim(), email = String(d.get('email') || '').trim();
    rememberForm();
    if (d.get('website')) { // verborgen veld ingevuld = bot: doe alsof het gelukt is
      state.done = { order_number: 'EL-0000', items: [], total: 0, delivery: 'afhalen', wa: '' }; CART.clear(); return;
    }
    if (name.length < 2) { return msg('Vul je naam in.'); }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { return msg('Vul een geldig e-mailadres in.'); }
    var ship = d.get('delivery') === 'verzenden';
    if (ship && (!String(d.get('street')).trim() || !String(d.get('postal')).trim() || !String(d.get('city')).trim())) { return msg('Vul je volledige adres in voor verzending.'); }
    if (!d.get('consent')) { return msg(ERRORS.akkoord_vereist); }
    if (state.blocked) { return msg('Verwijder eerst de producten die niet meer beschikbaar zijn.'); }
    msg('');

    var btn = document.getElementById('order-btn');
    state.busy = true; if (btn) { btn.disabled = true; btn.textContent = 'Even geduld…'; }
    var body = {
      p_items: CART.items().map(function (l) { return { product_id: l.id, variant_id: l.v, qty: l.q }; }),
      p_name: name, p_email: email, p_phone: String(d.get('phone') || '').trim() || null, p_delivery: ship ? 'verzenden' : 'afhalen',
      p_street: ship ? String(d.get('street')).trim() : null, p_postal: ship ? String(d.get('postal')).trim() : null, p_city: ship ? String(d.get('city')).trim() : null,
      p_notes: String(d.get('notes') || '').trim() || null, p_consent: true, p_expected_total: CART.totals().total
    };
    var headers = { 'Content-Type': 'application/json', apikey: CFG.supabaseKey };
    if (/^eyJ/.test(CFG.supabaseKey)) { headers.Authorization = 'Bearer ' + CFG.supabaseKey; }
    fetch(CFG.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/rpc/place_order', { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        state.busy = false;
        if (res.ok) {
          var o = res.body;
          o.wa = whatsappText(o.order_number);
          state.done = o; CART.clear(); render(); return;
        }
        var m = String((res.body && res.body.message) || ''), code = m.split(':')[0];
        if (code === 'prijs_gewijzigd') {
          return refreshLive().then(function () { render(); msg('De prijzen zijn intussen aangepast. Controleer je totaal en verstuur opnieuw.'); });
        }
        render();
        msg(ERRORS[code] || 'Je bestelling kon niet verstuurd worden. Probeer het opnieuw of stuur Aida een bericht via WhatsApp.');
      })
      .catch(function () {
        state.busy = false; render();
        msg('Geen verbinding. Probeer het opnieuw of stuur Aida een bericht via WhatsApp.');
      });
  }
  root.addEventListener('submit', function (e) { e.preventDefault(); if (!state.busy) { submit(e.target); } });

  render();
  refreshLive().then(function () { if (!state.done) { render(); } });
})();
