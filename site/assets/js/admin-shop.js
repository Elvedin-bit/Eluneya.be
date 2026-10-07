/* =============================================================================
   Eluneya — beheer van de webshop (onderdeel van admin.html, tabblad Shop)
   Producten, categorieën, voorraad en bestellingen. Alles loopt via de ingelogde Supabase-sessie van Aida;
   de database (supabase/shop.sql) laat enkel accounts in de tabel admins schrijven en bestellingen lezen.
   Er staat niets geheims in dit bestand. Wordt pas actief na openen van het tabblad Shop.
   ========================================================================== */
(function () {
  'use strict';

  var BUCKET = 'products', MAX_IMG = 3 * 1024 * 1024;
  var S = { sub: 'orders', cats: [], brands: [], products: [], editing: null, images: [], orderFilter: 'nieuw', order: null, ready: false };
  var db, root;

  /* ---------- hulp ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  function msg(id, text) { var m = $(id); if (m) { m.textContent = text || ''; m.hidden = !text; } }
  function money(n) { return '€ ' + Number(n).toFixed(2).replace('.', ','); }
  function num(s) { s = String(s == null ? '' : s).trim().replace(',', '.'); return s === '' ? null : Number(s); }
  function slugify(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
  }
  function list(s) { return String(s || '').split(/[,\n;]/).map(function (x) { return x.trim(); }).filter(Boolean); }
  function localDt(iso) { // ISO → waarde voor <input type=datetime-local> (lokale tijd)
    if (!iso) { return ''; }
    var d = new Date(iso), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function isoDt(v) { return v ? new Date(v).toISOString() : null; }
  function when(iso) { return new Date(iso).toLocaleString('nl-BE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function dbError(e) {
    var m = (e && e.message) || '';
    if (/products_slug_key/.test(m)) { return 'Deze URL-naam (slug) bestaat al. Kies een andere.'; }
    if (/product_categories_slug_key|brands_slug_key/.test(m)) { return 'Deze URL-naam (slug) bestaat al.'; }
    if (/products_sku_uidx/.test(m)) { return 'Deze productcode (SKU) bestaat al.'; }
    if (/products_sale_ok/.test(m)) { return 'De promotieprijs moet lager zijn dan de normale prijs.'; }
    if (/products_compare_ok/.test(m)) { return 'De oude prijs moet hoger zijn dan de normale prijs.'; }
    if (/products_sale_dates/.test(m)) { return 'Het einde van de actie moet na het begin liggen.'; }
    if (/product_attributes_data_check/.test(m)) { return 'De geurgegevens zijn ongeldig (te lang of verkeerd formaat).'; }
    if (/violates foreign key constraint.*category|product_categories.*restrict|still referenced/.test(m)) { return 'Deze categorie bevat nog producten. Verplaats of verwijder die eerst.'; }
    if (/geannuleerd_is_definitief/.test(m)) { return 'Een geannuleerde bestelling kan niet heropend worden.'; }
    if (/row-level security|permission denied/.test(m)) { return 'Je hebt geen rechten voor deze actie.'; }
    if (/relation|schema cache|does not exist/.test(m)) { return 'De shop-tabellen ontbreken nog. Voer eerst supabase/shop.sql uit.'; }
    return 'Opslaan mislukt: ' + m;
  }
  function confirmBtn(btn, label, action) { // dubbele klik om te bevestigen
    btn.addEventListener('click', function () {
      if (!btn.dataset.confirm) {
        btn.dataset.confirm = '1'; btn.textContent = 'Zeker? Klik opnieuw';
        window.setTimeout(function () { btn.dataset.confirm = ''; btn.textContent = label; }, 4000);
        return;
      }
      btn.disabled = true; action(btn);
    });
  }

  /* ---------- opbouw (eenmalig) ---------- */
  function build() {
    root.innerHTML =
      '<div class="tabs sub-tabs" role="group" aria-label="Shop-onderdeel">' +
      '<button class="tab" type="button" data-sub="orders" aria-pressed="true">Bestellingen <span class="count" id="sh-new-count" hidden></span></button>' +
      '<button class="tab" type="button" data-sub="products" aria-pressed="false">Producten</button>' +
      '<button class="tab" type="button" data-sub="categories" aria-pressed="false">Categorieën</button>' +
      '<button class="tab" type="button" data-sub="stock" aria-pressed="false">Voorraad</button></div>' +
      '<section class="panel" id="sh-orders"><div class="panel-head"><h2>Bestellingen</h2><div class="tabs" id="sh-order-filter" role="group" aria-label="Filter">' +
      [['nieuw', 'Nieuw'], ['in_behandeling', 'In behandeling'], ['klaar', 'Klaar'], ['afgerond', 'Afgerond'], ['geannuleerd', 'Geannuleerd'], ['', 'Alles']]
        .map(function (f) { return '<button class="tab" type="button" data-of="' + f[0] + '" aria-pressed="' + (f[0] === 'nieuw') + '">' + f[1] + '</button>'; }).join('') +
      '</div></div><p class="lead" style="margin-bottom:12px">Klanten plaatsen een bestelaanvraag. Bevestig ze, spreek betaling en levering af (bv. via WhatsApp) en zet hier de status.</p>' +
      '<p class="form-message is-error" id="sh-orders-msg" role="alert" hidden></p><div class="list" id="sh-orders-list" aria-live="polite"></div></section>' +
      '<section class="panel" id="sh-products" hidden><div class="panel-head"><h2>Producten</h2><button class="btn btn-dark btn-sm" type="button" id="sh-prod-new">+ Nieuw product</button></div>' +
      '<p class="form-message is-error" id="sh-prod-msg" role="alert" hidden></p><div class="list" id="sh-prod-list" aria-live="polite"></div></section>' +
      '<section class="panel" id="sh-categories" hidden><div class="panel-head"><h2>Categorieën</h2><button class="btn btn-dark btn-sm" type="button" id="sh-cat-new">+ Nieuwe categorie</button></div>' +
      '<p class="form-message is-error" id="sh-cat-msg" role="alert" hidden></p><div class="list" id="sh-cat-list"></div></section>' +
      '<section class="panel" id="sh-stock" hidden><div class="panel-head"><h2>Voorraad</h2></div>' +
      '<p class="lead" style="margin-bottom:12px">Pas voorraad en beschikbaarheid snel aan. Zet “Voorraad bijhouden” aan als een product uitverkocht moet raken zodra het op is.</p>' +
      '<p class="form-message is-error" id="sh-stock-msg" role="alert" hidden></p><div class="list" id="sh-stock-list"></div></section>';

    document.body.insertAdjacentHTML('beforeend', dialogs());
    root.querySelectorAll('[data-sub]').forEach(function (b) { b.addEventListener('click', function () { showSub(b.dataset.sub); }); });
    root.querySelectorAll('[data-of]').forEach(function (b) {
      b.addEventListener('click', function () {
        S.orderFilter = b.dataset.of;
        root.querySelectorAll('[data-of]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        renderOrders();
      });
    });
    $('sh-prod-new').addEventListener('click', function () { openProduct(null); });
    $('sh-cat-new').addEventListener('click', function () { openCategory(null); });
    document.querySelectorAll('#sh-prod-dlg [data-close], #sh-cat-dlg [data-close], #sh-order-dlg [data-close]').forEach(function (b) {
      b.addEventListener('click', function () { b.closest('dialog').close(); });
    });
    wireProductForm(); wireCategoryForm(); wireOrderDialog();
  }

  function dialogs() {
    var x = '<button class="icon-btn" type="button" data-close aria-label="Sluiten">✕</button>';
    return '' +
      '<dialog id="sh-prod-dlg" aria-labelledby="sh-p-title" style="width:min(760px,calc(100vw - 32px))"><form id="sh-prod-form" novalidate>' +
      '<div class="dlg-head"><h2 id="sh-p-title">Nieuw product</h2>' + x + '</div><div class="dlg-body">' +
      '<div class="field"><label for="sp-name">Naam *</label><input class="input" id="sp-name" maxlength="120" required></div>' +
      '<div class="grid-2"><div class="field"><label for="sp-cat">Categorie *</label><select class="select" id="sp-cat"></select></div>' +
      '<div class="field"><label for="sp-brand">Merk</label><select class="select" id="sp-brand"></select></div></div>' +
      '<div class="field" id="sp-newbrand-wrap" hidden><label for="sp-newbrand">Naam van het nieuwe merk</label><input class="input" id="sp-newbrand" maxlength="80"></div>' +
      '<div class="grid-2"><div class="field"><label for="sp-slug">Webadres <span class="hint">(automatisch, enkel kleine letters en -)</span></label><input class="input" id="sp-slug" maxlength="90" autocapitalize="none" spellcheck="false"></div>' +
      '<div class="field"><label for="sp-type">Soort product</label><select class="select" id="sp-type"><option value="physical">Fysiek product</option><option value="digital">Digitaal (e-book)</option><option value="workshop">Workshop</option></select></div></div>' +
      '<h3 class="sub-h">Prijs</h3><div class="grid-2"><div class="field"><label for="sp-price">Prijs (€, incl. btw) *</label><input class="input" id="sp-price" inputmode="decimal" required></div>' +
      '<div class="field"><label for="sp-compare">Oude prijs <span class="hint">(doorgestreept, optioneel)</span></label><input class="input" id="sp-compare" inputmode="decimal"></div></div>' +
      '<div class="field"><label for="sp-sale">Promotieprijs <span class="hint">(optioneel, lager dan de prijs)</span></label><input class="input" id="sp-sale" inputmode="decimal"></div>' +
      '<div class="grid-2"><div class="field"><label for="sp-sale-from">Actie vanaf <span class="hint">(leeg = meteen)</span></label><input class="input" id="sp-sale-from" type="datetime-local"></div>' +
      '<div class="field"><label for="sp-sale-to">Actie tot <span class="hint">(leeg = onbepaald)</span></label><input class="input" id="sp-sale-to" type="datetime-local"></div></div>' +
      '<h3 class="sub-h">Beschrijving</h3><div class="field"><label for="sp-short">Korte beschrijving <span class="hint">(max. 220 tekens, ook voor Google)</span></label><input class="input" id="sp-short" maxlength="220"></div>' +
      '<div class="field"><label for="sp-desc">Beschrijving <span class="hint">(lege regel = nieuwe alinea)</span></label><textarea class="textarea" id="sp-desc" rows="5" maxlength="5000"></textarea></div>' +
      '<div class="grid-2"><div class="field"><label for="sp-content">Inhoud <span class="hint">(bv. 50 ml)</span></label><input class="input" id="sp-content" maxlength="40"></div>' +
      '<div class="field"><label for="sp-sku">Productcode (SKU)</label><input class="input" id="sp-sku" maxlength="60" autocapitalize="characters"></div></div>' +
      '<div class="field"><label for="sp-ingr">Ingrediënten <span class="hint">(optioneel)</span></label><textarea class="textarea" id="sp-ingr" rows="2" maxlength="3000"></textarea></div>' +
      '<div id="sp-frag"><h3 class="sub-h">Geurprofiel</h3><div class="grid-2"><div class="field"><label for="sp-family">Geurfamilie <span class="hint">(bv. Bloemig, Oriëntaals)</span></label><input class="input" id="sp-family" maxlength="80"></div>' +
      '<div class="field"><label for="sp-conc">Concentratie <span class="hint">(bv. Eau de Parfum)</span></label><input class="input" id="sp-conc" maxlength="80"></div></div>' +
      '<div class="field"><label for="sp-top">Topnoten <span class="hint">(gescheiden door komma’s)</span></label><input class="input" id="sp-top" placeholder="bergamot, citroen"></div>' +
      '<div class="field"><label for="sp-heart">Hartnoten</label><input class="input" id="sp-heart" placeholder="jasmijn, roos"></div>' +
      '<div class="field"><label for="sp-base">Basisnoten</label><input class="input" id="sp-base" placeholder="vanille, musk, amber"></div></div>' +
      '<h3 class="sub-h">Foto’s</h3><p class="hint" style="margin-bottom:10px">De eerste foto is de hoofdfoto. JPG, PNG of WebP, max. 3 MB per foto.</p>' +
      '<div id="sp-images"></div><div class="field"><label for="sp-files" class="visually-hidden">Foto’s toevoegen</label><input class="input" id="sp-files" type="file" accept="image/jpeg,image/png,image/webp" multiple></div>' +
      '<h3 class="sub-h">Voorraad &amp; zichtbaarheid</h3><div class="grid-2"><div class="field"><label for="sp-avail">Beschikbaarheid</label><select class="select" id="sp-avail">' +
      '<option value="in_stock">Op voorraad</option><option value="out_of_stock">Uitverkocht</option><option value="preorder">Voorbestellen</option><option value="on_request">Enkel op aanvraag (via WhatsApp)</option></select></div>' +
      '<div class="field"><label for="sp-sort">Sorteerpositie <span class="hint">(laag = eerst)</span></label><input class="input" id="sp-sort" type="number" min="0" max="9999" value="0"></div></div>' +
      '<div class="checks"><label class="check"><input type="checkbox" id="sp-track"><span>Voorraad bijhouden (uitverkocht zodra het aantal 0 is)</span></label></div>' +
      '<div class="field" id="sp-stock-wrap" hidden><label for="sp-stock">Aantal op voorraad</label><input class="input" id="sp-stock" type="number" min="0" max="100000" value="0"></div>' +
      '<div class="checks"><label class="check"><input type="checkbox" id="sp-active"><span>Actief (zichtbaar en bestelbaar op de website)</span></label>' +
      '<label class="check"><input type="checkbox" id="sp-featured"><span>Uitgelicht (bovenaan in de shop)</span></label></div>' +
      '<p class="hint">Na het opslaan verschijnt een nieuw of aangepast product meteen in het overzicht en kan het besteld worden. De vaste productpagina (voor Google) wordt aangemaakt bij de volgende publicatie van de website.</p>' +
      '<p class="form-message is-error" id="sp-msg" role="alert" hidden></p>' +
      '<div class="dlg-actions"><button class="btn btn-outline btn-sm" type="button" data-close>Annuleren</button><button class="btn btn-dark btn-sm" type="submit" id="sp-submit">Product opslaan</button></div>' +
      '</div></form></dialog>' +

      '<dialog id="sh-cat-dlg" aria-labelledby="sh-c-title"><form id="sh-cat-form" novalidate><div class="dlg-head"><h2 id="sh-c-title">Nieuwe categorie</h2>' + x + '</div><div class="dlg-body">' +
      '<div class="field"><label for="sc-name">Naam *</label><input class="input" id="sc-name" maxlength="80" required></div>' +
      '<div class="field"><label for="sc-slug">Webadres <span class="hint">(kleine letters en -)</span></label><input class="input" id="sc-slug" maxlength="60" autocapitalize="none" spellcheck="false"></div>' +
      '<div class="field"><label for="sc-desc">Korte tekst <span class="hint">(bovenaan de categoriepagina)</span></label><textarea class="textarea" id="sc-desc" rows="3" maxlength="600"></textarea></div>' +
      '<div class="grid-2"><div class="field"><label for="sc-set">Soort velden</label><select class="select" id="sc-set"><option value="none">Standaard</option><option value="fragrance">Parfum (geurprofiel en noten)</option></select></div>' +
      '<div class="field"><label for="sc-sort">Sorteerpositie</label><input class="input" id="sc-sort" type="number" min="0" max="9999" value="0"></div></div>' +
      '<div class="checks"><label class="check"><input type="checkbox" id="sc-active" checked><span>Actief (zichtbaar op de website)</span></label></div>' +
      '<p class="form-message is-error" id="sc-msg" role="alert" hidden></p>' +
      '<div class="dlg-actions"><button class="btn btn-outline btn-sm" type="button" data-close>Annuleren</button><button class="btn btn-dark btn-sm" type="submit" id="sc-submit">Opslaan</button></div></div></form></dialog>' +

      '<dialog id="sh-order-dlg" aria-labelledby="so-title" style="width:min(640px,calc(100vw - 32px))"><div class="dlg-head"><h2 id="so-title">Bestelling</h2>' + x + '</div><div class="dlg-body">' +
      '<dl class="details" id="so-info"></dl><ul class="order-lines" id="so-lines"></ul>' +
      '<div class="grid-2" style="margin-top:18px"><div class="field"><label for="so-status">Status</label><select class="select" id="so-status">' +
      '<option value="nieuw">Nieuw</option><option value="in_behandeling">In behandeling</option><option value="klaar">Klaar</option><option value="afgerond">Afgerond</option><option value="geannuleerd">Geannuleerd</option></select></div>' +
      '<div class="field"><label for="so-pay">Betaling</label><select class="select" id="so-pay"><option value="open">Nog te betalen</option><option value="betaald">Betaald</option><option value="terugbetaald">Terugbetaald</option></select></div></div>' +
      '<div class="grid-2"><div class="field"><label for="so-prov">Betaalwijze <span class="hint">(bv. contant, overschrijving)</span></label><input class="input" id="so-prov" maxlength="40"></div>' +
      '<div class="field"><label for="so-ref">Referentie <span class="hint">(optioneel)</span></label><input class="input" id="so-ref" maxlength="120"></div></div>' +
      '<div class="field"><label for="so-notes">Interne notitie <span class="hint">(klant ziet dit niet)</span></label><textarea class="textarea" id="so-notes" rows="3" maxlength="2000"></textarea></div>' +
      '<p class="hint" id="so-cancel-hint" hidden>Annuleren zet de voorraad terug en kan niet ongedaan gemaakt worden.</p>' +
      '<p class="form-message is-error" id="so-msg" role="alert" hidden></p>' +
      '<div class="dlg-actions"><a class="btn btn-outline btn-sm" id="so-wa" target="_blank" rel="noopener">WhatsApp</a><a class="btn btn-outline btn-sm" id="so-mail">E-mail</a>' +
      '<button class="btn btn-dark btn-sm" type="button" id="so-save">Opslaan</button></div></div></dialog>';
  }

  /* ---------- navigatie ---------- */
  function showSub(name) {
    S.sub = name;
    root.querySelectorAll('[data-sub]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.sub === name)); });
    ['orders', 'products', 'categories', 'stock'].forEach(function (k) { $('sh-' + k).hidden = k !== name; });
    ({ orders: renderOrders, products: renderProducts, categories: renderCategories, stock: renderStock })[name]();
  }

  async function loadBase() {
    var c = await db.from('product_categories').select('*').order('sort_order').order('name');
    if (c.error) { throw c.error; }
    var b = await db.from('brands').select('*').order('name');
    if (b.error) { throw b.error; }
    S.cats = c.data; S.brands = b.data;
  }
  async function loadProducts() {
    var r = await db.from('products').select('*, product_images(*), product_attributes(data), brands(name), product_categories(name, slug, attribute_set)')
      .order('sort_order').order('name');
    if (r.error) { throw r.error; }
    r.data.forEach(function (p) {
      p.product_images.sort(function (a, b) { return (b.is_primary - a.is_primary) || (a.sort_order - b.sort_order); });
      var a = p.product_attributes; p.attrs = (Array.isArray(a) ? a[0] && a[0].data : a && a.data) || {};
    });
    S.products = r.data;
  }

  /* ---------- bestellingen ---------- */
  var ORDER_STATUS = { nieuw: 'Nieuw', in_behandeling: 'In behandeling', klaar: 'Klaar', afgerond: 'Afgerond', geannuleerd: 'Geannuleerd' };
  var PAY = { open: 'Nog te betalen', betaald: 'Betaald', terugbetaald: 'Terugbetaald' };

  async function renderOrders() {
    var box = $('sh-orders-list'); msg('sh-orders-msg');
    var q = db.from('orders').select('*, order_items(*)').order('created_at', { ascending: false }).limit(200);
    if (S.orderFilter) { q = q.eq('status', S.orderFilter); }
    var r = await q;
    if (r.error) { box.replaceChildren(el('p', 'empty', dbError(r.error))); return; }
    countNew();
    if (!r.data.length) { box.replaceChildren(el('p', 'empty', 'Geen bestellingen in deze lijst.')); return; }
    var frag = document.createDocumentFragment();
    r.data.forEach(function (o) {
      var row = el('div', 'row'); row.tabIndex = 0; row.setAttribute('role', 'button');
      var left = el('div'), n = o.order_items.reduce(function (s, i) { return s + i.quantity; }, 0);
      left.append(el('div', 'when', o.order_number + ' · ' + when(o.created_at)),
                  el('div', 'who', o.customer_name + ' — ' + n + (n === 1 ? ' product' : ' producten') + ' · ' + money(o.total_eur) + ' · ' + (o.delivery_method === 'verzenden' ? 'verzenden' : 'afhalen')));
      var tags = el('div', 'tags');
      tags.append(el('span', 'badge' + (o.status === 'geannuleerd' ? ' cancelled' : o.status === 'nieuw' ? ' soon' : o.status === 'afgerond' ? ' on' : ''), ORDER_STATUS[o.status]),
                  el('span', 'badge ' + (o.payment_status === 'betaald' ? 'on' : 'plain'), PAY[o.payment_status]));
      row.append(left, tags);
      row.addEventListener('click', function () { openOrder(o); });
      row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOrder(o); } });
      frag.append(row);
    });
    box.replaceChildren(frag);
  }

  async function countNew() {
    var r = await db.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'nieuw');
    var c = $('sh-new-count'); if (!c) { return; }
    c.textContent = String(r.count || 0); c.hidden = !r.count;
    var t = document.querySelector('[data-view="shop"]');
    if (t) { t.dataset.count = r.count || 0; t.textContent = r.count ? 'Shop (' + r.count + ' nieuw)' : 'Shop'; }
  }

  function openOrder(o) {
    S.order = o; msg('so-msg');
    var dl = $('so-info'); dl.replaceChildren();
    var addr = o.delivery_method === 'verzenden' ? o.ship_street + ', ' + o.ship_postal + ' ' + o.ship_city : 'Afhalen in Wevelgem';
    [['Bestelling', o.order_number + ' · ' + new Date(o.created_at).toLocaleString('nl-BE')], ['Klant', o.customer_name], ['E-mail', o.customer_email],
     ['Telefoon', o.customer_phone || '—'], ['Levering', addr], ['Opmerking klant', o.customer_notes || '—']]
      .forEach(function (p) { dl.append(el('dt', null, p[0]), el('dd', null, p[1])); });
    var ul = $('so-lines'); ul.replaceChildren();
    o.order_items.forEach(function (i) {
      var li = el('li'); li.append(el('span', null, i.quantity + '× ' + i.product_name + (i.variant_label ? ' (' + i.variant_label + ')' : '') + (i.sku ? ' · ' + i.sku : '')), el('span', null, money(i.line_total_eur)));
      ul.append(li);
    });
    var tot = el('li', 'sum'); tot.append(el('span', null, Number(o.discount_eur) > 0 ? 'Totaal (korting ' + money(o.discount_eur) + ')' : 'Totaal'), el('strong', null, money(o.total_eur))); ul.append(tot);
    $('so-status').value = o.status; $('so-pay').value = o.payment_status; $('so-prov').value = o.payment_provider || ''; $('so-ref').value = o.payment_reference || ''; $('so-notes').value = o.admin_notes || '';
    $('so-status').disabled = o.status === 'geannuleerd'; $('so-cancel-hint').hidden = true;
    var phone = (o.customer_phone || '').replace(/[^\d+]/g, '').replace(/^0/, '32').replace(/^\+/, '');
    $('so-wa').hidden = !phone;
    $('so-wa').href = 'https://wa.me/' + phone + '?text=' + encodeURIComponent('Hallo ' + o.customer_name.split(' ')[0] + ', bedankt voor je bestelaanvraag ' + o.order_number + ' bij Eluneya.');
    $('so-mail').href = 'mailto:' + o.customer_email + '?subject=' + encodeURIComponent('Je bestelling ' + o.order_number + ' bij Eluneya');
    $('sh-order-dlg').showModal();
  }

  function wireOrderDialog() {
    $('so-status').addEventListener('change', function () { $('so-cancel-hint').hidden = this.value !== 'geannuleerd'; });
    $('so-save').addEventListener('click', async function () {
      var o = S.order, btn = this, status = $('so-status').value;
      if (status === 'geannuleerd' && o.status !== 'geannuleerd' && !btn.dataset.confirm) {
        btn.dataset.confirm = '1'; btn.textContent = 'Zeker annuleren? Klik opnieuw'; return;
      }
      btn.dataset.confirm = ''; btn.textContent = 'Opslaan'; btn.disabled = true; msg('so-msg');
      var r = await db.from('orders').update({
        status: status, payment_status: $('so-pay').value, payment_provider: $('so-prov').value.trim() || null,
        payment_reference: $('so-ref').value.trim() || null, admin_notes: $('so-notes').value.trim() || null
      }).eq('id', o.id);
      btn.disabled = false;
      if (r.error) { msg('so-msg', dbError(r.error)); return; }
      $('sh-order-dlg').close(); renderOrders();
      S.products = []; // voorraad kan veranderd zijn (annulatie)
    });
  }

  /* ---------- producten ---------- */
  async function renderProducts() {
    var box = $('sh-prod-list'); msg('sh-prod-msg');
    try { await loadBase(); await loadProducts(); } catch (e) { box.replaceChildren(el('p', 'empty', dbError(e))); return; }
    if (!S.products.length) { box.replaceChildren(el('p', 'empty', 'Nog geen producten. Klik op “+ Nieuw product” om te beginnen.')); return; }
    var frag = document.createDocumentFragment();
    S.products.forEach(function (p) { frag.append(productRow(p)); });
    box.replaceChildren(frag);
  }

  function productRow(p) {
    var row = el('div', 'prow'), main = el('div', 'prow-main'), body = el('div'), thumb;
    var im = p.product_images[0];
    if (im) { thumb = el('img', 'prow-thumb'); thumb.src = im.url; thumb.alt = ''; thumb.loading = 'lazy'; }
    else { thumb = el('div', 'prow-thumb none', p.name.charAt(0)); thumb.setAttribute('aria-hidden', 'true'); }
    var tags = el('div', 'tags');
    tags.append(el('span', 'badge ' + (p.is_active ? 'on' : 'off'), p.is_active ? 'Actief' : 'Niet zichtbaar'));
    if (p.is_featured) { tags.append(el('span', 'badge soon', 'Uitgelicht')); }
    if (!p.is_available) { tags.append(el('span', 'badge cancelled', p.availability === 'on_request' ? 'Op aanvraag' : 'Uitverkocht')); }
    var price = money(p.price_eur) + (p.sale_price_eur != null ? ' → actie ' + money(p.sale_price_eur) : '');
    var stock = p.track_stock ? p.stock_qty + ' op voorraad' : 'voorraad niet bijgehouden';
    body.append(tags, el('h3', null, p.name),
      el('div', 'meta', [(p.product_categories || {}).name, (p.brands || {}).name, p.content_label].filter(Boolean).join(' · ')),
      el('div', 'meta', price + ' · ' + stock + (p.sku ? ' · ' + p.sku : '')));
    main.append(thumb, body);
    var acts = el('div', 'acts');
    var edit = el('button', 'btn btn-outline btn-sm', 'Bewerken'); edit.type = 'button'; edit.addEventListener('click', function () { openProduct(p); });
    var tog = el('button', 'btn btn-outline btn-sm', p.is_active ? 'Verbergen' : 'Activeren'); tog.type = 'button';
    tog.addEventListener('click', async function () {
      tog.disabled = true;
      var r = await db.from('products').update({ is_active: !p.is_active }).eq('id', p.id);
      if (r.error) { msg('sh-prod-msg', dbError(r.error)); tog.disabled = false; return; }
      renderProducts();
    });
    var del = el('button', 'btn btn-outline btn-sm', 'Verwijderen'); del.type = 'button';
    confirmBtn(del, 'Verwijderen', async function () {
      var urls = p.product_images.map(function (i) { return i.url; });
      var r = await db.from('products').delete().eq('id', p.id);
      if (r.error) { msg('sh-prod-msg', dbError(r.error)); del.disabled = false; return; }
      dropFiles(urls); renderProducts();
    });
    acts.append(edit, tog, del);
    row.append(main, acts);
    return row;
  }

  function storagePath(url) { var i = (url || '').indexOf('/object/public/' + BUCKET + '/'); return i < 0 ? null : decodeURIComponent(url.slice(i + 15 + BUCKET.length + 1).split('?')[0]); }
  async function dropFiles(urls) {
    var paths = urls.map(storagePath).filter(Boolean);
    if (paths.length) { await db.storage.from(BUCKET).remove(paths); }
  }

  function fillSelects(p) {
    var cs = $('sp-cat'); cs.replaceChildren();
    S.cats.forEach(function (c) { var o = el('option', null, c.name + (c.is_active ? '' : ' (verborgen)')); o.value = c.id; cs.append(o); });
    var bs = $('sp-brand'); bs.replaceChildren();
    var none = el('option', null, 'Geen merk'); none.value = ''; bs.append(none);
    S.brands.forEach(function (b) { var o = el('option', null, b.name); o.value = b.id; bs.append(o); });
    var nb = el('option', null, '+ Nieuw merk toevoegen…'); nb.value = '__new'; bs.append(nb);
  }
  function currentCat() { return S.cats.filter(function (c) { return c.id === $('sp-cat').value; })[0]; }
  function syncFragrance() {
    var c = currentCat(), has = S.editing && Object.keys(S.editing.attrs || {}).length;
    $('sp-frag').hidden = !(c && c.attribute_set === 'fragrance') && !has;
  }
  function syncStock() { $('sp-stock-wrap').hidden = !$('sp-track').checked; }

  function openProduct(p) {
    S.editing = p || null; msg('sp-msg');
    $('sh-prod-form').reset(); fillSelects(p);
    $('sh-p-title').textContent = p ? 'Product bewerken' : 'Nieuw product';
    $('sp-newbrand-wrap').hidden = true;
    var d = p || { name: '', slug: '', category_id: (S.cats[0] || {}).id, brand_id: null, product_type: 'physical', price_eur: '', compare_at_price_eur: null,
                   sale_price_eur: null, sale_starts_at: null, sale_ends_at: null, short_description: '', description: '', content_label: '', sku: '', ingredients: '',
                   availability: 'in_stock', sort_order: 0, track_stock: false, stock_qty: 0, is_active: false, is_featured: false };
    var a = (p && p.attrs) || {}, notes = a.notes || {};
    $('sp-name').value = d.name; $('sp-slug').value = d.slug; $('sp-slug').dataset.manual = p ? '1' : '';
    $('sp-cat').value = d.category_id; $('sp-brand').value = d.brand_id || ''; $('sp-type').value = d.product_type;
    $('sp-price').value = d.price_eur === '' ? '' : String(d.price_eur).replace('.', ',');
    $('sp-compare').value = d.compare_at_price_eur != null ? String(d.compare_at_price_eur).replace('.', ',') : '';
    $('sp-sale').value = d.sale_price_eur != null ? String(d.sale_price_eur).replace('.', ',') : '';
    $('sp-sale-from').value = localDt(d.sale_starts_at); $('sp-sale-to').value = localDt(d.sale_ends_at);
    $('sp-short').value = d.short_description || ''; $('sp-desc').value = d.description || ''; $('sp-content').value = d.content_label || '';
    $('sp-sku').value = d.sku || ''; $('sp-ingr').value = d.ingredients || '';
    $('sp-family').value = a.fragrance_family || ''; $('sp-conc').value = a.concentration || '';
    $('sp-top').value = (notes.top || []).join(', '); $('sp-heart').value = (notes.heart || []).join(', '); $('sp-base').value = (notes.base || []).join(', ');
    $('sp-avail').value = d.availability; $('sp-sort').value = d.sort_order; $('sp-track').checked = d.track_stock; $('sp-stock').value = d.stock_qty;
    $('sp-active').checked = d.is_active; $('sp-featured').checked = d.is_featured;
    S.images = p ? p.product_images.map(function (i) { return { id: i.id, url: i.url, alt: i.alt || '' }; }) : [];
    syncFragrance(); syncStock(); renderImages();
    $('sh-prod-dlg').showModal();
  }

  function renderImages() {
    var box = $('sp-images'); box.replaceChildren();
    S.images.forEach(function (im, i) {
      var r = el('div', 'img-item'), t = el('img'); t.src = im.preview || im.url; t.alt = '';
      var mid = el('div'), alt = el('input', 'input'); alt.value = im.alt; alt.placeholder = 'Beschrijving van de foto (voor slechtzienden en Google)'; alt.maxLength = 200;
      alt.setAttribute('aria-label', 'Beschrijving foto ' + (i + 1)); alt.addEventListener('input', function () { im.alt = alt.value; });
      mid.append(el('span', 'badge ' + (i === 0 ? 'on' : 'plain'), i === 0 ? 'Hoofdfoto' : 'Foto ' + (i + 1)), alt);
      var acts = el('div', 'acts');
      [['↑', 'Naar boven', -1], ['↓', 'Naar beneden', 1]].forEach(function (d) {
        var b = el('button', 'icon-btn', d[0]); b.type = 'button'; b.setAttribute('aria-label', d[1]); b.disabled = (i + d[2] < 0 || i + d[2] >= S.images.length);
        b.addEventListener('click', function () { var x = S.images.splice(i, 1)[0]; S.images.splice(i + d[2], 0, x); renderImages(); });
        acts.append(b);
      });
      var rm = el('button', 'icon-btn', '✕'); rm.type = 'button'; rm.setAttribute('aria-label', 'Foto verwijderen');
      rm.addEventListener('click', function () { var x = S.images.splice(i, 1)[0]; if (x.preview) { URL.revokeObjectURL(x.preview); } renderImages(); });
      acts.append(rm); r.append(t, mid, acts); box.append(r);
    });
  }

  function wireProductForm() {
    $('sp-name').addEventListener('input', function () { if (!$('sp-slug').dataset.manual) { $('sp-slug').value = slugify(this.value); } });
    $('sp-slug').addEventListener('input', function () { this.dataset.manual = '1'; });
    $('sp-cat').addEventListener('change', syncFragrance);
    $('sp-track').addEventListener('change', syncStock);
    $('sp-brand').addEventListener('change', function () { $('sp-newbrand-wrap').hidden = this.value !== '__new'; });
    $('sp-files').addEventListener('change', function () {
      Array.prototype.forEach.call(this.files, function (f) {
        if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { msg('sp-msg', 'Kies JPG-, PNG- of WebP-foto’s.'); return; }
        if (f.size > MAX_IMG) { msg('sp-msg', '“' + f.name + '” is groter dan 3 MB. Verklein de foto eerst.'); return; }
        if (S.images.length >= 10) { msg('sp-msg', 'Maximaal 10 foto’s per product.'); return; }
        S.images.push({ file: f, preview: URL.createObjectURL(f), alt: '' });
      });
      this.value = ''; renderImages();
    });
    $('sh-prod-dlg').addEventListener('close', function () { S.images.forEach(function (i) { if (i.preview) { URL.revokeObjectURL(i.preview); } }); });
    $('sh-prod-form').addEventListener('submit', saveProduct);
  }

  function readProduct() {
    var f = function (id) { return $(id).value.trim(); };
    var price = num(f('sp-price')), cmp = num(f('sp-compare')), sale = num(f('sp-sale'));
    var name = f('sp-name'), slug = f('sp-slug') || slugify(name), stock = $('sp-track').checked ? Number(f('sp-stock') || 0) : Number(f('sp-stock') || 0);
    var from = isoDt($('sp-sale-from').value), to = isoDt($('sp-sale-to').value), sort = Number(f('sp-sort') || 0), err = null;
    var notes = { top: list(f('sp-top')), heart: list(f('sp-heart')), base: list(f('sp-base')) };
    if (name.length < 2) { err = ['Vul een naam in (minstens 2 tekens).', 'sp-name']; }
    else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) { err = ['Het webadres mag enkel kleine letters, cijfers en - bevatten.', 'sp-slug']; }
    else if (!$('sp-cat').value) { err = ['Kies een categorie (maak er eerst een aan onder Categorieën).', 'sp-cat']; }
    else if (price == null || !isFinite(price) || price < 0 || price > 10000) { err = ['Vul een prijs in tussen € 0 en € 10.000.', 'sp-price']; }
    else if (cmp != null && !(cmp > price)) { err = ['De oude prijs moet hoger zijn dan de normale prijs.', 'sp-compare']; }
    else if (sale != null && !(sale >= 0 && sale < price)) { err = ['De promotieprijs moet lager zijn dan de normale prijs.', 'sp-sale']; }
    else if (from && to && to <= from) { err = ['Het einde van de actie moet na het begin liggen.', 'sp-sale-to']; }
    else if ((from || to) && sale == null) { err = ['Vul ook een promotieprijs in, of maak de datums leeg.', 'sp-sale']; }
    else if (!Number.isInteger(stock) || stock < 0 || stock > 100000) { err = ['De voorraad moet een heel getal van 0 of meer zijn.', 'sp-stock']; }
    else if (!Number.isInteger(sort) || sort < 0 || sort > 9999) { err = ['De sorteerpositie moet een heel getal van 0 tot 9999 zijn.', 'sp-sort']; }
    else if ($('sp-brand').value === '__new' && !f('sp-newbrand')) { err = ['Vul de naam van het nieuwe merk in.', 'sp-newbrand']; }
    else if (['top', 'heart', 'base'].some(function (k) { return notes[k].length > 20 || notes[k].some(function (n) { return n.length > 60; }); })) {
      err = ['Per noten-laag maximaal 20 noten van elk max. 60 tekens.', 'sp-top'];
    }
    if (err) { return { error: err }; }
    return { row: {
      name: name, slug: slug, category_id: $('sp-cat').value, product_type: $('sp-type').value, price_eur: price,
      compare_at_price_eur: cmp, sale_price_eur: sale, sale_starts_at: sale == null ? null : from, sale_ends_at: sale == null ? null : to,
      short_description: f('sp-short') || null, description: f('sp-desc') || null, content_label: f('sp-content') || null,
      sku: f('sp-sku') || null, ingredients: f('sp-ingr') || null, availability: $('sp-avail').value, sort_order: sort,
      track_stock: $('sp-track').checked, stock_qty: stock, is_active: $('sp-active').checked, is_featured: $('sp-featured').checked
    }, notes: notes, family: f('sp-family'), conc: f('sp-conc') };
  }

  async function saveProduct(e) {
    e.preventDefault(); msg('sp-msg');
    var res = readProduct();
    if (res.error) { msg('sp-msg', res.error[0]); $(res.error[1]).focus(); return; }
    var btn = $('sp-submit'); btn.disabled = true;
    try {
      var row = res.row, brand = $('sp-brand').value;
      if (brand === '__new') {
        var nm = $('sp-newbrand').value.trim(), nr = await db.from('brands').insert({ name: nm, slug: slugify(nm) || 'merk' }).select().single();
        if (nr.error) { msg('sp-msg', dbError(nr.error)); return; }
        brand = nr.data.id;
      }
      row.brand_id = brand || null;
      var saved;
      if (S.editing) { saved = await db.from('products').update(row).eq('id', S.editing.id).select().single(); }
      else { saved = await db.from('products').insert(row).select().single(); }
      if (saved.error) { msg('sp-msg', dbError(saved.error)); return; }
      var id = saved.data.id;
      S.editing = Object.assign({ attrs: {}, product_images: [] }, saved.data, { attrs: (S.editing && S.editing.attrs) || {}, product_images: (S.editing && S.editing.product_images) || [] });

      // geurgegevens (andere sleutels die er al stonden blijven behouden)
      var a = Object.assign({}, S.editing.attrs), notes = {};
      ['top', 'heart', 'base'].forEach(function (k) { if (res.notes[k].length) { notes[k] = res.notes[k]; } });
      if (res.family) { a.fragrance_family = res.family; } else { delete a.fragrance_family; }
      if (res.conc) { a.concentration = res.conc; } else { delete a.concentration; }
      if (Object.keys(notes).length) { a.notes = notes; } else { delete a.notes; }
      var ar = Object.keys(a).length ? await db.from('product_attributes').upsert({ product_id: id, data: a }) : await db.from('product_attributes').delete().eq('product_id', id);
      if (ar.error) { msg('sp-msg', 'Product opgeslagen, maar de geurgegevens niet: ' + dbError(ar.error)); return; }

      // foto's: verwijderde weg, nieuwe uploaden, volgorde en hoofdfoto bijwerken
      var keep = S.images.filter(function (i) { return i.id; }).map(function (i) { return i.id; });
      var gone = S.editing.product_images.filter(function (i) { return keep.indexOf(i.id) < 0; });
      if (gone.length) {
        var dr = await db.from('product_images').delete().in('id', gone.map(function (i) { return i.id; }));
        if (dr.error) { msg('sp-msg', 'Product opgeslagen, maar foto’s verwijderen mislukte: ' + dbError(dr.error)); return; }
        dropFiles(gone.map(function (i) { return i.url; }));
      }
      for (var k = 0; k < S.images.length; k++) {
        var im = S.images[k];
        if (im.file) {
          var ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[im.file.type];
          var path = id + '/' + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + k) + '.' + ext;
          var up = await db.storage.from(BUCKET).upload(path, im.file, { contentType: im.file.type, cacheControl: '31536000' });
          if (up.error) { msg('sp-msg', 'Product opgeslagen, maar een foto uploaden mislukte: ' + up.error.message + ' (is de map “products” aangemaakt via shop.sql?)'); renderProducts(); return; }
          var ins = await db.from('product_images').insert({ product_id: id, url: db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl, alt: im.alt || null, sort_order: k, is_primary: false }).select().single();
          if (ins.error) { msg('sp-msg', dbError(ins.error)); return; }
          im.id = ins.data.id; im.url = ins.data.url; delete im.file;
        }
      }
      if (S.images.length) { // eerst iedereen niet-primair (unieke index), dan de eerste primair
        var cl = await db.from('product_images').update({ is_primary: false }).eq('product_id', id);
        if (cl.error) { msg('sp-msg', dbError(cl.error)); return; }
        for (var j = 0; j < S.images.length; j++) {
          var u = await db.from('product_images').update({ sort_order: j, is_primary: j === 0, alt: S.images[j].alt || null }).eq('id', S.images[j].id);
          if (u.error) { msg('sp-msg', dbError(u.error)); return; }
        }
      }
      $('sh-prod-dlg').close(); renderProducts();
    } finally { btn.disabled = false; }
  }

  /* ---------- categorieën ---------- */
  function renderCategories() {
    var box = $('sh-cat-list'); msg('sh-cat-msg');
    loadBase().then(function () {
      if (!S.cats.length) { box.replaceChildren(el('p', 'empty', 'Nog geen categorieën. Voer shop.sql uit of voeg er een toe.')); return; }
      var frag = document.createDocumentFragment();
      S.cats.forEach(function (c) {
        var row = el('div', 'prow'), body = el('div'), tags = el('div', 'tags');
        tags.append(el('span', 'badge ' + (c.is_active ? 'on' : 'off'), c.is_active ? 'Zichtbaar' : 'Verborgen'));
        if (c.attribute_set === 'fragrance') { tags.append(el('span', 'badge plain', 'Parfum-velden')); }
        body.append(tags, el('h3', null, c.name), el('div', 'meta', '/shop/' + c.slug + '/ · positie ' + c.sort_order));
        var acts = el('div', 'acts');
        var edit = el('button', 'btn btn-outline btn-sm', 'Bewerken'); edit.type = 'button'; edit.addEventListener('click', function () { openCategory(c); });
        var del = el('button', 'btn btn-outline btn-sm', 'Verwijderen'); del.type = 'button';
        confirmBtn(del, 'Verwijderen', async function () {
          var r = await db.from('product_categories').delete().eq('id', c.id);
          if (r.error) { msg('sh-cat-msg', dbError(r.error)); del.disabled = false; return; }
          renderCategories();
        });
        acts.append(edit, del); row.append(body, acts); frag.append(row);
      });
      box.replaceChildren(frag);
    }).catch(function (e) { box.replaceChildren(el('p', 'empty', dbError(e))); });
  }
  function openCategory(c) {
    S.editingCat = c || null; msg('sc-msg'); $('sh-cat-form').reset();
    $('sh-c-title').textContent = c ? 'Categorie bewerken' : 'Nieuwe categorie';
    var d = c || { name: '', slug: '', description: '', attribute_set: 'none', sort_order: (S.cats.length + 1) * 10, is_active: true };
    $('sc-name').value = d.name; $('sc-slug').value = d.slug; $('sc-slug').dataset.manual = c ? '1' : ''; $('sc-desc').value = d.description || '';
    $('sc-set').value = d.attribute_set; $('sc-sort').value = d.sort_order; $('sc-active').checked = d.is_active;
    $('sh-cat-dlg').showModal();
  }
  function wireCategoryForm() {
    $('sc-name').addEventListener('input', function () { if (!$('sc-slug').dataset.manual) { $('sc-slug').value = slugify(this.value).slice(0, 60); } });
    $('sc-slug').addEventListener('input', function () { this.dataset.manual = '1'; });
    $('sh-cat-form').addEventListener('submit', async function (e) {
      e.preventDefault(); msg('sc-msg');
      var name = $('sc-name').value.trim(), slug = $('sc-slug').value.trim() || slugify(name).slice(0, 60), sort = Number($('sc-sort').value || 0);
      if (name.length < 2) { msg('sc-msg', 'Vul een naam in (minstens 2 tekens).'); return; }
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) { msg('sc-msg', 'Het webadres mag enkel kleine letters, cijfers en - bevatten.'); return; }
      if (!Number.isInteger(sort) || sort < 0 || sort > 9999) { msg('sc-msg', 'De sorteerpositie moet een heel getal van 0 tot 9999 zijn.'); return; }
      var row = { name: name, slug: slug, description: $('sc-desc').value.trim() || null, attribute_set: $('sc-set').value, sort_order: sort, is_active: $('sc-active').checked };
      $('sc-submit').disabled = true;
      var r = S.editingCat ? await db.from('product_categories').update(row).eq('id', S.editingCat.id) : await db.from('product_categories').insert(row);
      $('sc-submit').disabled = false;
      if (r.error) { msg('sc-msg', dbError(r.error)); return; }
      $('sh-cat-dlg').close(); renderCategories();
    });
  }

  /* ---------- voorraad ---------- */
  async function renderStock() {
    var box = $('sh-stock-list'); msg('sh-stock-msg');
    try { await loadProducts(); } catch (e) { box.replaceChildren(el('p', 'empty', dbError(e))); return; }
    if (!S.products.length) { box.replaceChildren(el('p', 'empty', 'Nog geen producten.')); return; }
    var frag = document.createDocumentFragment();
    S.products.forEach(function (p) {
      var row = el('div', 'stock-row'), name = el('div'), ctr = el('div', 'stock-ctrl');
      name.append(el('strong', null, p.name), el('div', 'meta', [p.sku, (p.product_categories || {}).name].filter(Boolean).join(' · ')));
      var track = el('label', 'check'), tc = el('input'); tc.type = 'checkbox'; tc.checked = p.track_stock; track.append(tc, el('span', null, 'Bijhouden'));
      var qty = el('input', 'input'); qty.type = 'number'; qty.min = 0; qty.max = 100000; qty.value = p.stock_qty; qty.disabled = !p.track_stock; qty.setAttribute('aria-label', 'Voorraad van ' + p.name);
      tc.addEventListener('change', function () { qty.disabled = !tc.checked; });
      var av = el('select', 'select'); av.setAttribute('aria-label', 'Beschikbaarheid van ' + p.name);
      [['in_stock', 'Op voorraad'], ['out_of_stock', 'Uitverkocht'], ['preorder', 'Voorbestellen'], ['on_request', 'Op aanvraag']].forEach(function (o) { var x = el('option', null, o[1]); x.value = o[0]; av.append(x); });
      av.value = p.availability;
      var save = el('button', 'btn btn-outline btn-sm', 'Opslaan'); save.type = 'button';
      save.addEventListener('click', async function () {
        var q = Number(qty.value || 0);
        if (!Number.isInteger(q) || q < 0 || q > 100000) { msg('sh-stock-msg', 'De voorraad van “' + p.name + '” moet een heel getal van 0 of meer zijn.'); return; }
        save.disabled = true;
        var r = await db.from('products').update({ track_stock: tc.checked, stock_qty: q, availability: av.value }).eq('id', p.id);
        save.disabled = false;
        if (r.error) { msg('sh-stock-msg', dbError(r.error)); return; }
        msg('sh-stock-msg'); save.textContent = 'Opgeslagen ✓'; setTimeout(function () { save.textContent = 'Opslaan'; }, 1800);
      });
      if (p.track_stock && p.stock_qty <= 2) { row.classList.add('low'); }
      ctr.append(track, qty, av, save); row.append(name, ctr); frag.append(row);
    });
    box.replaceChildren(frag);
  }

  /* ---------- openen vanuit admin.html ---------- */
  window.ELUNEYA_ADMIN_SHOP = {
    open: function () {
      var A = window.ELUNEYA_ADMIN;
      root = $('view-shop');
      if (!A || !A.db || !root) { return; }
      db = A.db;
      if (!S.ready) { build(); S.ready = true; }
      showSub(S.sub);
    },
    countNew: function () { if (window.ELUNEYA_ADMIN && window.ELUNEYA_ADMIN.db) { db = window.ELUNEYA_ADMIN.db; root = $('view-shop'); return countNewSafe(); } }
  };
  function countNewSafe() {
    return db.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'nieuw').then(function (r) {
      var t = document.querySelector('[data-view="shop"]');
      if (t && !r.error) { t.textContent = r.count ? 'Shop (' + r.count + ' nieuw)' : 'Shop'; }
    });
  }
})();
