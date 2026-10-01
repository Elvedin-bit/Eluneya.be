/* =============================================================================
   Eluneya — online agenda
   Werkt samen met supabase/schema.sql via twee RPC-functies:
     get_booked_slots(p_from, p_to) en book_appointment(...).
   De server controleert alles opnieuw (duur, openingsuren, overlap); deze code
   zorgt enkel voor een vlotte, duidelijke ervaring.
   ========================================================================== */
(function () {
  'use strict';

  var CFG = window.ELUNEYA_CONFIG || {};
  var DATA = window.ELUNEYA_DATA;
  var $ = function (id) { return document.getElementById(id); };

  var form = $('booking-form');
  var unavailable = $('booking-unavailable');
  var done = $('booking-done');
  if (!form || !unavailable || !done) { return; }

  var configured = DATA && /^https:\/\/[^\s]+$/.test(CFG.supabaseUrl || '') && !!CFG.supabaseKey;
  if (!configured) { unavailable.hidden = false; return; }
  form.hidden = false;

  /* ---------- Elementen & gegevens ---------- */
  var el = {
    service: $('service'), serviceSummary: $('service-summary'),
    onlineWrap: $('online-wrap'), online: $('online'),
    prev: $('prev-week'), next: $('next-week'), weekLabel: $('week-label'),
    days: $('day-row'), slots: $('slot-row'),
    name: $('name'), email: $('email'), phone: $('phone'), notes: $('notes'), honeypot: $('website'),
    summary: $('booking-summary'), message: $('form-message'), submit: $('submit-btn'),
    doneDetails: $('done-details'), ics: $('ics-link')
  };

  var SERVICES = {};
  DATA.services.forEach(function (s) { SERVICES[s.slug] = s; });
  var HOURS = DATA.openingHours;           // { "1": ["18:30","20:30"], ... } 0 = zondag
  var RULES = DATA.rules;
  var CONTACT = DATA.contact;
  var WA = 'https://wa.me/' + CONTACT.whatsapp;
  var DAY_SHORT = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];

  var state = { offset: 0, date: null, slot: null, loading: false, loadError: false };
  var cache = {};            // weekKey -> [{date:'YYYY-MM-DD', s:minuten, e:minuten}]
  var weekController = null;
  var icsUrl = null;

  /* ---------- Hulpfuncties ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); } // lokale datum, géén UTC
  function toMin(t) { var p = String(t).split(':'); return (+p[0]) * 60 + (+p[1]) + ((+p[2] || 0) > 0 ? 1 : 0); }
  function hm(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function weekStart(offset) { var t = startOfDay(new Date()); t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + offset * 7); return t; }
  function fmt(d, opts) { return d.toLocaleDateString('nl-BE', opts); }
  function price(p) { return p === 0 ? 'gratis' : '€ ' + p.toFixed(2).replace('.', ','); }
  function duration(m) { if (m < 60) { return m + ' min'; } var h = Math.floor(m / 60), r = m % 60; return h + 'u' + (r ? pad(r) : ''); }
  function currentService() { return SERVICES[el.service.value] || null; }
  function today() { return startOfDay(new Date()); }
  function lastBookableDay() { return addDays(today(), RULES.maxDaysAhead); }

  /* ---------- API ---------- */
  function api(fn, body, controller) {
    var headers = { 'Content-Type': 'application/json', 'apikey': CFG.supabaseKey };
    if (/^eyJ/.test(CFG.supabaseKey)) { headers.Authorization = 'Bearer ' + CFG.supabaseKey; } // oude anon-sleutel (JWT)
    var ctrl = controller || new AbortController();
    var timer = window.setTimeout(function () { ctrl.abort(); }, 15000);
    return fetch(CFG.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/rpc/' + fn, {
      method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctrl.signal
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.message) || ('HTTP ' + res.status));
          err.code = data && data.code; err.status = res.status;
          throw err;
        }
        return data;
      });
    }).finally(function () { window.clearTimeout(timer); });
  }

  /* ---------- Beschikbaarheid ---------- */
  function loadWeek(force) {
    var start = weekStart(state.offset);
    var key = ymd(start);
    if (cache[key] && !force) { render(); return; }
    if (weekController) { weekController.abort(); }
    var ctrl = new AbortController();
    weekController = ctrl;
    state.loading = true; state.loadError = false;
    render();
    api('get_booked_slots', { p_from: key, p_to: ymd(addDays(start, 6)) }, ctrl)
      .then(function (rows) {
        cache[key] = (rows || []).map(function (r) {
          return { date: r.booking_date, s: toMin(r.start_time), e: toMin(r.blocked_until) };
        });
      })
      .catch(function (err) {
        if (ctrl !== weekController) { return; }          // vervangen door een nieuwere aanvraag
        if (err && (err.code === 'PGRST202' || err.status === 404)) { showUnavailable(); return; } // functie bestaat nog niet
        state.loadError = true;
      })
      .finally(function () {
        if (ctrl === weekController) { state.loading = false; weekController = null; render(); }
      });
  }

  function bookedOn(dateKey) {
    var week = cache[ymd(weekStart(state.offset))];
    return week ? week.filter(function (b) { return b.date === dateKey; }) : null;
  }

  // Tijdsloten voor een dag: past de volledige behandeling binnen de openingsuren,
  // ligt ze ver genoeg in de toekomst en overlapt ze geen bestaande afspraak (+ buffer)?
  function slotsFor(day, service) {
    var h = HOURS[String(day.getDay())];
    if (!h || !service) { return []; }
    var open = toMin(h[0]), close = toMin(h[1]);
    var booked = bookedOn(ymd(day)) || [];
    var earliest = Date.now() + RULES.minNoticeHours * 3600 * 1000;
    var out = [];
    for (var t = open; t + service.duration <= close; t += RULES.slotStep) {
      var startTs = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(t / 60), t % 60).getTime();
      var blockEnd = t + service.duration + RULES.bufferMinutes;
      var taken = booked.some(function (b) { return t < b.e && b.s < blockEnd; });
      out.push({ time: hm(t), ok: startTs >= earliest && !taken });
    }
    return out;
  }

  function dayStatus(day, service) {
    if (day < today() || day > lastBookableDay()) { return 'past'; }
    if (!HOURS[String(day.getDay())]) { return 'closed'; }
    if (!service || !bookedOn(ymd(day))) { return 'open'; }   // nog niets geladen of geen behandeling: niet voorbarig blokkeren
    return slotsFor(day, service).some(function (s) { return s.ok; }) ? 'open' : 'full';
  }

  /* ---------- Weergave ---------- */
  function render() {
    renderWeek();
    renderSlots();
    renderSummary();
  }

  function renderWeek() {
    var start = weekStart(state.offset), end = addDays(start, 6), service = currentService();
    el.weekLabel.textContent = fmt(start, { day: 'numeric', month: 'short' }) + ' – ' + fmt(end, { day: 'numeric', month: 'short' });
    el.prev.disabled = state.offset <= 0;
    el.next.disabled = addDays(start, 7) > lastBookableDay();

    var frag = document.createDocumentFragment();
    for (var i = 0; i < 7; i++) {
      var d = addDays(start, i);
      var status = dayStatus(d, service);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'day-btn';
      btn.dataset.date = ymd(d);
      var selected = state.date && ymd(state.date) === ymd(d);
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
      var label = fmt(d, { weekday: 'long', day: 'numeric', month: 'long' });
      if (status !== 'open') {
        btn.disabled = true;
        label += status === 'closed' ? ', gesloten' : status === 'full' ? ', volzet' : ', niet beschikbaar';
      }
      btn.setAttribute('aria-label', label);
      btn.innerHTML = '<span class="dname" aria-hidden="true">' + DAY_SHORT[d.getDay()] + '</span><span class="dnum" aria-hidden="true">' + d.getDate() + '</span>';
      frag.appendChild(btn);
    }
    el.days.replaceChildren(frag);
  }

  function slotNote(text, withRetry) {
    var p = document.createElement('p');
    p.className = 'slot-empty';
    p.textContent = text;
    if (withRetry) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'text-link'; b.textContent = 'Opnieuw proberen';
      b.style.marginLeft = '6px';
      b.addEventListener('click', function () { loadWeek(true); });
      p.appendChild(b);
    }
    el.slots.replaceChildren(p);
  }

  function renderSlots() {
    var service = currentService();
    if (!service) { slotNote('Kies eerst een behandeling.'); return; }
    if (!state.date) { slotNote('Kies een dag om de vrije uren te zien.'); return; }
    if (state.loadError) { slotNote('De vrije uren konden niet geladen worden.', true); return; }
    if (state.loading || !bookedOn(ymd(state.date))) { slotNote('Vrije uren laden…'); return; }

    var slots = slotsFor(state.date, service);
    if (!slots.some(function (s) { return s.ok; })) {
      slotNote('Op deze dag is er geen moment meer vrij voor deze behandeling. Kies een andere dag.');
      return;
    }
    var frag = document.createDocumentFragment();
    slots.forEach(function (s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot-btn';
      btn.textContent = s.time;
      btn.dataset.time = s.time;
      btn.disabled = !s.ok;
      btn.setAttribute('aria-pressed', s.time === state.slot ? 'true' : 'false');
      if (!s.ok) { btn.setAttribute('aria-label', s.time + ', niet beschikbaar'); }
      frag.appendChild(btn);
    });
    el.slots.replaceChildren(frag);
  }

  function renderSummary() {
    var service = currentService();
    if (service) {
      var parts = [];
      if (service.showDuration) { parts.push(duration(service.duration)); }
      parts.push(price(service.price));
      el.serviceSummary.textContent = parts.join(' · ');
    } else {
      el.serviceSummary.textContent = '';
    }
    el.onlineWrap.hidden = !(service && service.slug === 'intakegesprek');

    if (service && state.date && state.slot) {
      el.summary.innerHTML = '';
      var strong = document.createElement('strong');
      strong.textContent = service.name;
      el.summary.appendChild(strong);
      el.summary.appendChild(document.createTextNode(
        ' op ' + fmt(state.date, { weekday: 'long', day: 'numeric', month: 'long' }) + ' om ' + state.slot +
        ' · ' + price(service.price)));
    } else {
      el.summary.textContent = !service ? 'Kies een behandeling, dag en uur.'
        : !state.date ? 'Kies nog een dag en een uur.' : 'Kies nog een uur.';
    }
  }

  function showMessage(text, type, withWhatsApp) {
    el.message.className = 'form-message ' + (type === 'info' ? 'is-info' : 'is-error');
    el.message.textContent = text;
    if (withWhatsApp) {
      el.message.appendChild(document.createTextNode(' '));
      var a = document.createElement('a');
      a.href = WA; a.target = '_blank'; a.rel = 'noopener'; a.className = 'text-link';
      a.textContent = 'Stuur een WhatsApp-bericht';
      el.message.appendChild(a);
      el.message.appendChild(document.createTextNode('.'));
    }
    el.message.hidden = false;
  }
  function clearMessage() { el.message.hidden = true; el.message.textContent = ''; }

  function showUnavailable() {
    if (weekController) { weekController.abort(); weekController = null; }
    form.hidden = true;
    unavailable.hidden = false;
  }

  /* ---------- Interactie ---------- */
  el.service.addEventListener('change', function () {
    state.slot = null;
    clearMessage();
    render();
  });

  el.days.addEventListener('click', function (e) {
    var btn = e.target.closest('.day-btn');
    if (!btn || btn.disabled) { return; }
    var p = btn.dataset.date.split('-');
    state.date = new Date(+p[0], +p[1] - 1, +p[2]);
    state.slot = null;
    clearMessage();
    render();
  });

  el.slots.addEventListener('click', function (e) {
    var btn = e.target.closest('.slot-btn');
    if (!btn || btn.disabled) { return; }
    state.slot = btn.dataset.time;
    clearMessage();
    renderSlots();
    renderSummary();
    var again = el.slots.querySelector('[data-time="' + state.slot + '"]');
    if (again) { again.focus(); }
  });

  el.prev.addEventListener('click', function () { if (state.offset > 0) { state.offset--; state.slot = null; loadWeek(); } });
  el.next.addEventListener('click', function () { if (!el.next.disabled) { state.offset++; state.slot = null; loadWeek(); } });

  [el.name, el.email].forEach(function (input) {
    input.addEventListener('input', function () { input.removeAttribute('aria-invalid'); });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearMessage();
    var service = currentService();

    if (!service) { showMessage('Kies eerst een behandeling.'); el.service.focus(); return; }
    if (!state.date || !state.slot) {
      showMessage('Kies nog een dag en een uur.');
      var target = !state.date ? el.days.querySelector('.day-btn:not(:disabled)') : el.slots.querySelector('.slot-btn:not(:disabled)');
      if (target) { target.focus(); }
      return;
    }
    var name = el.name.value.trim(), email = el.email.value.trim();
    var invalid = [];
    if (name.length < 2) { invalid.push(el.name); }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { invalid.push(el.email); }
    invalid.forEach(function (i) { i.setAttribute('aria-invalid', 'true'); });
    if (invalid.length) {
      showMessage(invalid.length === 2 ? 'Vul je naam en een geldig e-mailadres in.'
        : invalid[0] === el.name ? 'Vul je naam in.' : 'Vul een geldig e-mailadres in.');
      invalid[0].focus();
      return;
    }

    // Spambot vulde het verborgen veld in: doe alsof het gelukt is, maar boek niets.
    if (el.honeypot && el.honeypot.value) { showDone({ service: service.name, start: state.slot, end: state.slot }, service); return; }

    var notes = el.notes.value.trim();
    if (service.slug === 'intakegesprek' && el.online.checked) { notes = '[Online intake gewenst] ' + notes; }

    setBusy(true);
    api('book_appointment', {
      p_service: service.slug,
      p_date: ymd(state.date),
      p_start: state.slot,
      p_name: name,
      p_email: email,
      p_phone: el.phone.value.trim() || null,
      p_notes: notes || null
    })
      .then(function (res) {
        delete cache[ymd(weekStart(state.offset))];
        showDone(res, service);
      })
      .catch(handleError)
      .finally(function () { setBusy(false); });
  });

  function setBusy(busy) {
    el.submit.disabled = busy;
    el.submit.setAttribute('aria-busy', String(busy));
    el.submit.textContent = busy ? 'Bezig met bevestigen…' : 'Bevestig afspraak';
  }

  function handleError(err) {
    var m = (err && err.message) || '';
    if (err && (err.code === 'PGRST202' || err.status === 404)) { showUnavailable(); return; }
    if (m.indexOf('tijdslot_bezet') > -1) {
      state.slot = null;
      showMessage('Dit moment werd net door iemand anders geboekt. Kies een ander uur.');
      loadWeek(true);
    } else if (m.indexOf('te_kort_op_voorhand') > -1) {
      showMessage('Dit moment ligt te kort op voorhand om online te boeken.', 'error', true);
      state.slot = null; render();
    } else if (/buiten_openingsuren|ongeldig_tijdslot|gesloten|te_ver_vooruit/.test(m)) {
      state.slot = null;
      showMessage('Dit moment is niet (meer) beschikbaar. Kies een ander uur.');
      loadWeek(true);
    } else if (m.indexOf('te_veel_boekingen') > -1) {
      showMessage('Je hebt al enkele afspraken openstaan. Wil je er nog een bij?', 'error', true);
    } else if (m.indexOf('onbekende_behandeling') > -1) {
      showMessage('Deze behandeling kan momenteel niet online geboekt worden.', 'error', true);
    } else if (m.indexOf('ongeldige_gegevens') > -1) {
      showMessage('Controleer je naam en e-mailadres en probeer opnieuw.');
    } else {
      showMessage('Er ging iets mis met de verbinding. Probeer het opnieuw, of', 'error', true);
    }
  }

  /* ---------- Bevestiging ---------- */
  function showDone(res, service) {
    var day = state.date;
    var when = fmt(day, { weekday: 'long', day: 'numeric', month: 'long' });
    el.doneDetails.textContent = (res.service || service.name) + ' op ' + when + ' om ' + res.start + '. Adres: ' + CONTACT.address + '.';
    buildIcs(res, service, day);
    form.hidden = true;
    done.hidden = false;
    done.focus({ preventScroll: true });
    done.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  function buildIcs(res, service, day) {
    var d = ymd(day).replace(/-/g, '');
    var start = res.start.replace(':', '') + '00';
    var endMin = toMin(res.start) + service.duration;
    var end = hm(endMin).replace(':', '') + '00';
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    var esc = function (s) { return String(s).replace(/[\\;,]/g, function (c) { return '\\' + c; }); };
    var ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Eluneya//Afspraak//NL', 'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'UID:' + (res.id || stamp) + '@eluneya',
      'DTSTAMP:' + stamp,
      'DTSTART;TZID=Europe/Brussels:' + d + 'T' + start,
      'DTEND;TZID=Europe/Brussels:' + d + 'T' + end,
      'SUMMARY:' + esc('Eluneya — ' + (res.service || service.name)),
      'LOCATION:' + esc(CONTACT.address),
      'DESCRIPTION:' + esc('Iets wijzigen? Stuur een bericht via WhatsApp: ' + WA),
      'END:VEVENT', 'END:VCALENDAR'
    ].join('\r\n');
    if (icsUrl) { URL.revokeObjectURL(icsUrl); }
    icsUrl = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    el.ics.href = icsUrl;
  }
  window.addEventListener('pagehide', function () { if (icsUrl) { URL.revokeObjectURL(icsUrl); } });

  /* ---------- Start ---------- */
  var wanted = new URLSearchParams(window.location.search).get('behandeling');
  if (wanted && SERVICES[wanted]) { el.service.value = wanted; }

  // Zit er deze week geen enkel boekbaar moment meer in? Begin dan bij volgende week.
  (function () {
    var start = weekStart(0), anyOpen = false;
    for (var i = 0; i < 7; i++) {
      var d = addDays(start, i), h = HOURS[String(d.getDay())];
      if (d >= today() && h) {
        var close = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() + toMin(h[1]) * 60000;
        if (close - Date.now() > RULES.minNoticeHours * 3600000) { anyOpen = true; }
      }
    }
    if (!anyOpen) { state.offset = 1; }
  })();

  loadWeek();
})();
