/* Eluneya — algemene interactie (header, mobiel menu, scroll-reveal, jaartal).
   Geen afhankelijkheden. Werkt de site zonder JavaScript, dan blijft alle inhoud zichtbaar. */
(function () {
  'use strict';

  var doc = document.documentElement;
  var body = document.body;
  var header = document.querySelector('.site-header');
  var toggle = document.querySelector('.nav-toggle');
  var menu = document.getElementById('mobile-menu');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- Header: vaste achtergrond na scrollen (alleen pagina's met fotoheader) ---------- */
  if (header && body.classList.contains('has-hero')) {
    var ticking = false;
    var updateHeader = function () {
      header.classList.toggle('is-scrolled', window.scrollY > 40);
      ticking = false;
    };
    window.addEventListener('scroll', function () {
      if (!ticking) { window.requestAnimationFrame(updateHeader); ticking = true; }
    }, { passive: true });
    updateHeader();
  }

  /* ---------- Mobiel menu ---------- */
  if (toggle && menu) {
    var outside = Array.prototype.slice.call(document.querySelectorAll('main, footer'));
    var desktop = window.matchMedia('(min-width: 1000px)');

    var setOpen = function (open, returnFocus) {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Menu sluiten' : 'Menu openen');
      menu.classList.toggle('is-open', open);
      header.classList.toggle('menu-open', open);
      body.style.overflow = open ? 'hidden' : '';
      outside.forEach(function (el) {
        if (open) { el.setAttribute('inert', ''); } else { el.removeAttribute('inert'); }
      });
      if (open) {
        var first = menu.querySelector('a');
        if (first) { window.setTimeout(function () { first.focus(); }, 50); }
      } else if (returnFocus) {
        toggle.focus();
      }
    };

    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true', true);
    });
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) { setOpen(false, false); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setOpen(false, true); }
    });
    var onBreakpoint = function (e) { if (e.matches) { setOpen(false, false); } };
    if (desktop.addEventListener) { desktop.addEventListener('change', onBreakpoint); }
    else if (desktop.addListener) { desktop.addListener(onBreakpoint); }
  }

  /* ---------- Scroll-reveal ---------- */
  var revealEls = document.querySelectorAll('.reveal');
  var showAll = function () {
    for (var i = 0; i < revealEls.length; i++) { revealEls[i].classList.add('is-visible'); }
  };
  if (reduceMotion.matches || !('IntersectionObserver' in window)) {
    showAll();
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    for (var i = 0; i < revealEls.length; i++) { io.observe(revealEls[i]); }
    // Vangnet: wie via een anker of afdrukken op een sectie belandt, ziet nooit lege blokken.
    window.addEventListener('beforeprint', showAll);
  }

  /* ---------- Jaartal in footer ---------- */
  var year = document.querySelector('[data-year]');
  if (year) { year.textContent = String(new Date().getFullYear()); }

  doc.classList.add('js-ready');
})();
