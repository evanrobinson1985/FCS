/*
 * Dark mode for the whole site.
 *
 * The pages carry hundreds of colours written straight into their HTML and
 * scripts, so instead of a hand-made dark copy of each, this looks at every
 * element's actual (computed) colours and, in dark mode, turns light
 * backgrounds and borders dark and dark text light - keeping each colour's
 * hue, so a yellow warning stays yellow-ish and a red error stays red.
 * Content added later (popups, tables, dialogs) is handled as it appears.
 * Switching back puts every original colour back.
 *
 * Light mode until someone switches to dark; their choice is saved per
 * browser ("fcs-theme": "dark" or "light") and used on every visit. Load
 * this script in <head> so a dark-mode visitor doesn't see a white flash.
 *
 * Left alone: images, video, canvases (the 3D view, charts - see
 * FCSTheme.onChange), map tiles, colour pickers, and anything inside an
 * element marked data-theme-keep.
 */
(function () {
  'use strict';
  const KEY = 'fcs-theme';
  const root = document.documentElement;

  function savedChoice() {
    try { const v = localStorage.getItem(KEY); return v === 'dark' || v === 'light' ? v : null; } catch (e) { return null; }
  }
  function wanted() {
    return savedChoice() || 'light';
  }

  // ---- colour helpers ----
  function parseColor(str) {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(str || '');
    if (!m) return null;
    let a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  function toHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: h / 6, s, l };
  }
  function hslCss({ h, s, l }, a) {
    const alpha = a === undefined || a >= 1 ? '' : ` / ${a}`;
    return `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%${alpha})`;
  }
  function luminance({ r, g, b }) {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  // Light background -> dark surface (same hue, toned down)
  function darkBackground(c) {
    const hsl = toHsl(c);
    if (hsl.l < 0.72) return null; // already mid or dark: leave it (buttons, badges, the header)
    return hslCss({ h: hsl.h, s: Math.min(hsl.s, 0.5) * 0.7, l: 0.09 + (1 - hsl.l) * 0.55 }, c.a);
  }
  // Light border -> dark border
  function darkBorder(c) {
    const hsl = toHsl(c);
    if (hsl.l < 0.65) return null;
    return hslCss({ h: hsl.h, s: hsl.s * 0.4, l: 0.27 }, c.a);
  }
  // Dark text -> light text (same hue)
  function lightText(c) {
    const hsl = toHsl(c);
    if (hsl.l > 0.55) return null;
    const l = hsl.s > 0.25 ? Math.max(0.68, 1 - hsl.l * 0.75) : 0.9 - hsl.l * 0.25;
    return hslCss({ h: hsl.h, s: Math.min(1, hsl.s * 0.9 + 0.05), l }, c.a);
  }

  const SKIP_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'PICTURE', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'OBJECT', 'EMBED', 'TEMPLATE', 'svg', 'SVG']);
  function skipped(el) {
    return SKIP_TAGS.has(el.tagName) || (el.tagName === 'INPUT' && el.type === 'color') ||
      (el.classList && (el.classList.contains('leaflet-tile-pane') || el.classList.contains('leaflet-tile'))) ||
      (el.hasAttribute && el.hasAttribute('data-theme-keep'));
  }

  // ---- applying / undoing ----
  const touched = new Set();
  const PROPS = ['background-color', 'color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'background-image'];
  function remember(el) {
    if (el.__fcsOrig) return;
    el.__fcsOrig = {};
    for (const p of PROPS) el.__fcsOrig[p] = [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)];
    touched.add(el);
  }
  function setProp(el, prop, value) {
    remember(el);
    el.style.setProperty(prop, value, 'important');
    // stored as the browser writes it back (hsl() reads back as rgb()), so
    // our own change is recognised later and not mistaken for the page's
    (el.__fcsSet || (el.__fcsSet = {}))[prop] = el.style.getPropertyValue(prop);
  }
  function restore(el) {
    if (!el.__fcsOrig) return;
    for (const p of PROPS) {
      const [v, pri] = el.__fcsOrig[p];
      if (v) el.style.setProperty(p, v, pri); else el.style.removeProperty(p);
    }
    el.__fcsOrig = null;
    el.__fcsSet = null;
  }

  // Effective background lightness of an element's surroundings, so text
  // is only lightened where the background behind it is (now) dark
  function processTree(start, parentBgLum) {
    const stack = [[start, parentBgLum]];
    while (stack.length) {
      const [el, inheritedLum] = stack.pop();
      if (el.nodeType !== 1) continue;
      if (skipped(el)) continue;
      let bgLum = inheritedLum;
      const cs = getComputedStyle(el);
      // own values set by us last time don't count as "original"
      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0.05) {
        const mapped = el.__fcsSet && el.__fcsSet['background-color'] ? null : darkBackground(bg);
        if (mapped) {
          setProp(el, 'background-color', mapped);
          // light gradient backgrounds (e.g. "linear-gradient(#fff, #eee)") would hide the new colour
          if (cs.backgroundImage && cs.backgroundImage.includes('gradient')) setProp(el, 'background-image', 'none');
          bgLum = 0.02;
        } else if (!(el.__fcsSet && el.__fcsSet['background-color'])) {
          bgLum = bg.a > 0.5 ? luminance(bg) : inheritedLum;
        } else {
          bgLum = 0.02;
        }
      }
      if (!(el.__fcsSet && el.__fcsSet['border-top-color'])) {
        const widths = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth];
        ['top', 'right', 'bottom', 'left'].forEach((side, i) => {
          if (parseFloat(widths[i]) > 0) {
            const bc = parseColor(cs[`border${side[0].toUpperCase()}${side.slice(1)}Color`]);
            const mappedBorder = bc && bc.a > 0.05 && darkBorder(bc);
            if (mappedBorder) setProp(el, `border-${side}-color`, mappedBorder);
          }
        });
      }
      if (bgLum < 0.2 && !(el.__fcsSet && el.__fcsSet.color)) {
        const fg = parseColor(cs.color);
        const mappedText = fg && lightText(fg);
        if (mappedText) setProp(el, 'color', mappedText);
      }
      for (let i = el.children.length - 1; i >= 0; i--) stack.push([el.children[i], bgLum]);
    }
  }

  function backgroundBehind(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.__fcsSet && p.__fcsSet['background-color']) return 0.02;
      const bg = parseColor(getComputedStyle(p).backgroundColor);
      if (bg && bg.a > 0.5) return luminance(bg);
    }
    return 0.02;
  }

  let observer = null;
  const pending = new Set();
  let scheduled = false;
  function flush() {
    scheduled = false;
    const items = [...pending];
    pending.clear();
    // only the outermost changed elements need a pass
    const roots = items.filter((el) => el.isConnected && !items.some((o) => o !== el && o.contains(el)));
    for (const el of roots) processTree(el, backgroundBehind(el));
  }
  function queue(el) {
    pending.add(el);
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  }
  function startObserving() {
    if (observer || !document.body) return;
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList') {
          m.addedNodes.forEach((n) => { if (n.nodeType === 1) queue(n); });
        } else if (m.type === 'attributes') {
          const el = m.target;
          // a page script changed this element's own style/class: re-read it
          if (m.attributeName === 'style' && el.__fcsSet) {
            const ours = Object.entries(el.__fcsSet).every(([p, v]) => el.style.getPropertyValue(p) === v);
            if (ours) continue;
            restore(el);
          } else if (m.attributeName === 'class' && el.__fcsSet) {
            restore(el);
          }
          queue(el);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  }
  function stopObserving() {
    if (observer) observer.disconnect();
    observer = null;
    pending.clear();
  }

  const listeners = [];
  function apply(theme) {
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
    if (!document.body) return;
    if (theme === 'dark') {
      processTree(document.body, 0.02);
      startObserving();
    } else {
      stopObserving();
      for (const el of touched) restore(el);
      touched.clear();
    }
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
      btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      btn.setAttribute('aria-pressed', String(theme === 'dark'));
    });
    listeners.forEach((fn) => { try { fn(theme); } catch (e) { console.error(e); } });
  }

  window.FCSTheme = {
    get: () => root.getAttribute('data-theme') || wanted(),
    set(theme) {
      try { localStorage.setItem(KEY, theme); } catch (e) { /* storage blocked: still switch for this page */ }
      apply(theme);
    },
    toggle() { this.set(this.get() === 'dark' ? 'light' : 'dark'); },
    // For things drawn on a canvas (charts) that need redrawing in the other theme
    onChange(fn) { listeners.push(fn); },
  };

  // Before the page draws: set the base colours (styles in dark-mode.css)
  root.setAttribute('data-theme', wanted());
  root.style.colorScheme = wanted();
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => btn.addEventListener('click', () => window.FCSTheme.toggle()));
    apply(wanted());
  });
})();
