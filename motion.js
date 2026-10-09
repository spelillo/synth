// motion.js — the moving parts of motion.css.
//
// - Press feedback: pressables shrink the instant a pointer goes down and
//   spring back on release, starting from wherever they are on screen, so
//   quick repeated taps never jump.
// - Anchored origins: modals and popovers grow out of the control that
//   opened them (and shrink back into it) instead of from their centre.
// - Header material: measures the header for --chrome-h and shows its
//   bottom edge only while content is scrolled underneath it.
(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  // Critically damped spring (damping 1.0, response 0.35s); same samples as
  // --ease-spring in motion.css.
  var SPRING = 'linear(0, 0.037, 0.121, 0.227, 0.336, 0.441, 0.536, 0.619, 0.69, 0.75, 0.8, 0.84, 0.873, 0.9, 0.921, 0.938, 0.952, 0.962, 0.971, 0.977, 0.982, 0.986, 0.99, 0.992, 0.994, 0.995, 0.996, 0.997, 0.998, 0.998, 1)';

  // ---- Press feedback ----

  var PRESSABLE = 'button, a.auth-btn, [role="button"], .preview-dataset-card, .learn-level-card, .learn-promo';
  var pressed = null;
  var pressAnims = new WeakMap();

  function currentScale(el) {
    var s = getComputedStyle(el).scale;
    var n = parseFloat(s);
    return s && s !== 'none' && !isNaN(n) ? n : 1;
  }

  function animateScale(el, to, options) {
    if (!el.animate) return;
    var from = currentScale(el); // the presentation value, mid-flight or not
    var prev = pressAnims.get(el);
    var anim = el.animate([{ scale: String(from) }, { scale: String(to) }], options);
    if (prev) prev.cancel();
    pressAnims.set(el, anim);
    if (to === 1) {
      anim.onfinish = function () { if (pressAnims.get(el) === anim) { anim.cancel(); pressAnims.delete(el); } };
    }
  }

  function press(el) {
    if (reduceMotion.matches) {
      el.animate && pressAnims.set(el, el.animate([{ opacity: 1 }, { opacity: 0.72 }], { duration: 80, fill: 'forwards' }));
      return;
    }
    var r = el.getBoundingClientRect();
    // About 4px of travel whatever the size: buttons dip to ~0.97, big
    // cards barely move.
    var to = Math.min(0.99, Math.max(0.97, 1 - 4 / Math.max(r.width, r.height, 1)));
    animateScale(el, to, { duration: 90, easing: 'ease-out', fill: 'forwards' });
  }

  function release(el) {
    if (reduceMotion.matches) {
      var a = pressAnims.get(el);
      if (a) a.cancel();
      pressAnims.delete(el);
      return;
    }
    animateScale(el, 1, { duration: 420, easing: SPRING, fill: 'forwards' });
  }

  function endPress() {
    if (!pressed) return;
    release(pressed);
    pressed = null;
  }

  document.addEventListener('pointerdown', function (e) {
    lastTrigger = e.target.closest ? e.target.closest('button, a, [role="button"], [onclick]') || e.target : null;
    lastTriggerAt = performance.now();
    if (e.button !== 0 || !e.target.closest) return;
    var el = e.target.closest(PRESSABLE);
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('.pane-resizer')) return;
    endPress();
    pressed = el;
    press(el);
  }, true);
  document.addEventListener('pointerup', endPress, true);
  document.addEventListener('pointercancel', endPress, true);
  // Dragging off the control lets it go, like cancelling a tap.
  document.addEventListener('pointerout', function (e) {
    if (pressed && e.target === pressed && !pressed.contains(e.relatedTarget)) endPress();
  }, true);

  // ---- Anchored origins for modals and popovers ----

  var lastTrigger = null;
  var lastTriggerAt = 0;
  var POPOVERS = '.workspace-switcher-panel, .focus-dropdown-panel, .query-card-menu-popup';

  // The element's box without its current transform, so a surface that is
  // mid-animation still gets an exact origin.
  function untransformedRect(el) {
    var r = el.getBoundingClientRect();
    var w = el.offsetWidth || r.width;
    var h = el.offsetHeight || r.height;
    var sx = w ? r.width / w : 1;
    var sy = h ? r.height / h : 1;
    var origin = getComputedStyle(el).transformOrigin.split(' ');
    var ox = parseFloat(origin[0]) || 0;
    var oy = parseFloat(origin[1]) || 0;
    return { left: r.left - ox * (1 - sx), top: r.top - oy * (1 - sy), width: w, height: h };
  }

  function anchorTo(surface, prop) {
    var trigger = lastTrigger;
    var recent = trigger && document.contains(trigger) && performance.now() - lastTriggerAt < 1500;
    if (!recent || surface.contains(trigger)) {
      surface.style.removeProperty(prop);
      return;
    }
    var t = trigger.getBoundingClientRect();
    var box = untransformedRect(surface);
    var x = Math.round(t.left + t.width / 2 - box.left);
    var y = Math.round(t.top + t.height / 2 - box.top);
    surface.style.setProperty(prop, x + 'px ' + y + 'px');
  }

  function onShown(el) {
    if (el.classList.contains('modal-overlay')) {
      var card = el.querySelector(':scope > .modal');
      if (card) anchorTo(card, 'transform-origin');
    } else if (el.matches(POPOVERS)) {
      anchorTo(el, '--popover-origin');
    }
  }

  // ---- Header: measured height and scroll edge ----

  var header = document.querySelector('body > .header');
  var SCROLLERS = '#home-view, #learn-overview, .learn-lesson';

  function updateScrollEdge() {
    if (!header) return;
    var under = false;
    document.querySelectorAll(SCROLLERS).forEach(function (el) {
      if (el.offsetParent !== null && el.scrollTop > 0) under = true;
    });
    header.classList.toggle('is-scrolled-under', under);
  }

  if (header) {
    var setChrome = function () { root.style.setProperty('--chrome-h', header.offsetHeight + 'px'); };
    setChrome();
    if (window.ResizeObserver) new ResizeObserver(setChrome).observe(header);
    document.addEventListener('scroll', function (e) {
      if (e.target && e.target.matches && e.target.matches(SCROLLERS)) updateScrollEdge();
    }, true);
  }

  // One observer for everything that shows and hides with [hidden].
  new MutationObserver(function (records) {
    var viewChanged = false;
    records.forEach(function (r) {
      var el = r.target;
      if (el.nodeType !== 1) return;
      if (r.oldValue !== null && !el.hidden) onShown(el);
      if (el.matches(SCROLLERS) || el.id === 'learn-view' || el.id === 'app-view') viewChanged = true;
    });
    if (viewChanged) updateScrollEdge();
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });
})();
