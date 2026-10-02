/* =============================================================================
   Eluneya — promoties op de website: popup + banner
   Leest de lopende promoties uit Supabase (tabel promotions; de database laat bezoekers
   enkel actieve promoties binnen hun start- en einddatum zien) en toont ze.
   Er wordt niets geschreven en er zit geen geheime sleutel in: enkel de publieke sleutel.
   Beheer gebeurt door Aida in admin.html → tabblad Promoties.
   ========================================================================== */
(function () {
  'use strict';

  var CFG = window.ELUNEYA_CONFIG || {};
  var DATA = window.ELUNEYA_DATA || { services: [] };
  if (!/^https:\/\/[^\s]+$/.test(CFG.supabaseUrl || '') || !CFG.supabaseKey) { return; }

  var POPUP_REPEAT_DAYS = 7;      // een popup die gezien werd, komt pas na zoveel dagen terug
  var STORE = 'eluneya:';
  var root = document.documentElement;
  var script = document.currentScript;
  var BASE = script && script.src ? script.src.replace(/assets\/js\/promotions\.js.*$/, '') : '';
  var onBooking = /afspraak(\.html)?\/?$/.test(window.location.pathname);

  /* ---------- opslag (kan ontbreken of geweigerd worden: dan gewoon zonder geheugen) ---------- */
  function read(kind, key) { try { return window[kind].getItem(STORE + key); } catch (e) { return null; } }
  function write(kind, key, val) { try { window[kind].setItem(STORE + key, val); } catch (e) { /* negeren */ } }

  /* ---------- gegevens ---------- */
  var COLS = 'id,title,description,image_url,discount_type,discount_value,service_slug,end_date,show_popup,show_banner,popup_delay,button_text,priority,requires_code';

  function load() {
    var headers = { apikey: CFG.supabaseKey, Accept: 'application/json' };
    if (/^eyJ/.test(CFG.supabaseKey)) { headers.Authorization = 'Bearer ' + CFG.supabaseKey; }
    var ctrl = new AbortController(), timer = window.setTimeout(function () { ctrl.abort(); }, 8000);
    return fetch(CFG.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/promotions?select=' + COLS + '&order=priority.desc,end_date.asc',
      { headers: headers, signal: ctrl.signal })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (rows) { return Array.isArray(rows) ? rows.filter(valid) : []; })
      .catch(function () { return []; })
      .finally(function () { window.clearTimeout(timer); });
  }

  function valid(p) {
    return p && typeof p.id === 'string' && typeof p.title === 'string' && p.title &&
      (p.discount_type === 'percentage' || p.discount_type === 'fixed') && isFinite(+p.discount_value);
  }

  /* ---------- teksten ---------- */
  function serviceName(p) {
    var s = (DATA.services || []).filter(function (x) { return x.slug === p.service_slug; })[0];
    return s ? s.name : null;
  }
  function discountLabel(p) {
    var v = +p.discount_value;
    return p.discount_type === 'percentage' ? String(v).replace('.', ',') + '% korting' : '€ ' + v.toFixed(2).replace('.00', '').replace('.', ',') + ' korting';
  }
  function offerPhrase(p) {
    var name = serviceName(p);
    return discountLabel(p) + (name ? ' op ' + name : (p.service_slug ? '' : ' op elke behandeling')) + (p.requires_code ? ' met promotiecode' : '');
  }
  function untilText(p) {
    if (!p.end_date) { return ''; }
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.end_date);
    if (!m) { return ''; }
    return 'Tot en met ' + new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('nl-BE', { day: 'numeric', month: 'long' });
  }
  function bookHref(p) {
    var known = p.service_slug && (DATA.services || []).some(function (s) { return s.slug === p.service_slug; });
    return BASE + 'afspraak.html' + (known ? '?behandeling=' + encodeURIComponent(p.service_slug) : '');
  }
  function button(p) { return (p.button_text && String(p.button_text).trim()) || 'Boek nu'; }
  function node(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  var CLOSE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  /* ---------- banner ---------- */
  function showBanner(p) {
    var header = document.querySelector('.site-header');
    if (!header || read('sessionStorage', 'banner-closed')) { return false; }

    var bar = node('div', 'promo-banner');
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Actie');
    var inner = node('div', 'container promo-banner-inner');
    var text = node('p', 'promo-banner-text');
    text.append(node('strong', null, p.title), document.createTextNode(' '), node('span', 'promo-banner-offer', offerPhrase(p)));
    var link = node('a', 'promo-banner-btn', button(p));
    link.href = bookHref(p);
    var close = node('button', 'promo-banner-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Banner sluiten');
    close.innerHTML = CLOSE_SVG;
    inner.append(text, link, close);
    bar.append(inner);
    header.parentNode.insertBefore(bar, header);
    root.classList.add('has-promo-banner');

    // De header zweeft vast bovenaan; hij schuift mee omlaag zolang de banner nog zichtbaar is.
    function sync() { root.style.setProperty('--promo-h', Math.max(0, bar.offsetHeight - (window.pageYOffset || 0)) + 'px'); }
    window.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    sync();

    close.addEventListener('click', function () {
      write('sessionStorage', 'banner-closed', '1');        // tijdens dit bezoek geen banner meer
      window.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      bar.remove();
      root.classList.remove('has-promo-banner');
      root.style.removeProperty('--promo-h');
    });
    return true;
  }

  /* ---------- popup ---------- */
  function seenRecently(p) {
    var t = +read('localStorage', 'popup:' + p.id);
    return t > 0 && Date.now() - t < POPUP_REPEAT_DAYS * 86400000;
  }

  function buildPopup(p) {
    var dlg = node('dialog', 'promo-popup');
    var tid = 'promo-title-' + p.id.slice(0, 8);
    dlg.setAttribute('aria-labelledby', tid);
    var card = node('div', 'promo-popup-card');
    card.tabIndex = -1; card.setAttribute('autofocus', '');   // focus naar de kaart, niet naar de sluitknop

    var close = node('button', 'promo-popup-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Sluiten');
    close.innerHTML = CLOSE_SVG;
    card.append(close);

    if (p.image_url && /^https:\/\//.test(p.image_url)) {
      var img = node('img', 'promo-popup-media');
      img.src = p.image_url; img.alt = ''; img.decoding = 'async';
      card.append(img);
    }
    var body = node('div', 'promo-popup-body');
    var until = untilText(p);
    if (until) { body.append(node('p', 'eyebrow', until)); }
    var h = node('h2', null, p.title); h.id = tid;
    body.append(h, node('p', 'promo-popup-badge', offerPhrase(p)));
    if (p.description) { body.append(node('p', 'promo-popup-text', p.description)); }
    if (p.requires_code) { body.append(node('p', 'promo-popup-hint', 'Vul je promotiecode in bij het boeken.')); }
    var cta = node('a', 'btn btn-dark', button(p));
    cta.href = bookHref(p);
    body.append(cta);
    card.append(body);
    dlg.append(card);

    function dismiss() { if (dlg.open) { dlg.close(); } }
    close.addEventListener('click', dismiss);
    dlg.addEventListener('click', function (e) { if (e.target === dlg) { dismiss(); } });   // klik naast de kaart
    dlg.addEventListener('close', function () { dlg.remove(); });
    return dlg;
  }

  function schedulePopup(p) {
    var dlg;
    if (typeof HTMLDialogElement === 'undefined' || read('sessionStorage', 'popup-shown')) { return; }
    if (p.image_url && /^https:\/\//.test(p.image_url)) { new Image().src = p.image_url; }   // alvast laden
    var tries = 0;
    function attempt() {
      var a = document.activeElement;
      var typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
      var busy = typing || document.querySelector('dialog[open]') || document.querySelector('.site-header.menu-open');
      if (busy && tries++ < 6) { window.setTimeout(attempt, 5000); return; }   // niet storen tijdens typen of in het menu
      if (busy) { return; }
      write('localStorage', 'popup:' + p.id, String(Date.now()));
      write('sessionStorage', 'popup-shown', '1');
      dlg = buildPopup(p);
      document.body.append(dlg);
      dlg.showModal();
    }
    window.setTimeout(attempt, Math.max(0, Math.min(120, +p.popup_delay || 0)) * 1000);
  }

  /* ---------- start ---------- */
  load().then(function (list) {
    if (!list.length) { return; }
    var banner = list.filter(function (p) { return p.show_banner; });
    for (var i = 0; i < banner.length; i++) { if (showBanner(banner[i])) { break; } }
    if (onBooking) { return; }                                  // op de afsprakenpagina zijn ze al aan het boeken
    var popup = list.filter(function (p) { return p.show_popup && !seenRecently(p); })[0];
    if (popup) { schedulePopup(popup); }
  });
})();
