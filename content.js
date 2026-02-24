// content.js — runs at document_start
//
// Strategy:
//  1. URL extraction (query params, hidden inputs, data attrs, inline JS)
//     → navigate immediately if destination found
//  2. Timer acceleration — make countdowns expire instantly
//  3. Button auto-clicker — click "Get Link" / "Continue" buttons as soon
//     as they appear, using a known selector list + heuristic fallback
//  4. MutationObserver — re-run all of the above as DOM changes

(function () {
  'use strict';

  // ─── Trusted domains — exit immediately ──────────────────────────────────────
  const TRUSTED = [
    'google.com','googleapis.com','gstatic.com','youtube.com','gmail.com',
    'github.com','github.io','githubusercontent.com',
    'microsoft.com','live.com','office.com','outlook.com','bing.com',
    'apple.com','icloud.com','amazon.com','aws.amazon.com',
    'tumblr.com','twitter.com','x.com','facebook.com','instagram.com',
    'linkedin.com','pinterest.com','reddit.com','redd.it',
    'whatsapp.com','telegram.org','t.me',
    'wikipedia.org','wikimedia.org',
    'stackoverflow.com','stackexchange.com','cloudflare.com',
    'yahoo.com','duckduckgo.com','netflix.com','spotify.com',
    'dropbox.com','paypal.com','stripe.com',
  ];

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
    catch { return ''; }
  }
  function isTrusted(h) {
    return TRUSTED.some(t => h === t || h.endsWith('.' + t));
  }

  if (isTrusted(hostOf(location.href))) return;

  // ─── Loop guard ───────────────────────────────────────────────────────────────
  const STORAGE_KEY = 'adbypass_last_dest';
  const currentHost = hostOf(location.href);
  try {
    const lastDest = sessionStorage.getItem(STORAGE_KEY);
    if (lastDest && hostOf(lastDest) === currentHost) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
  } catch {}

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function b64decode(str) {
    if (!str || str.length < 16) return null;
    if (/^\d+$/.test(str.trim())) return null;
    if (/[^A-Za-z0-9+/=_\-]/.test(str.trim())) return null;
    try {
      const s = str.trim().replace(/-/g, '+').replace(/_/g, '/');
      const decoded = atob(s + '='.repeat((4 - s.length % 4) % 4));
      if (/[\x00-\x08\x0E-\x1F\x7F]/.test(decoded)) return null;
      return decoded;
    } catch { return null; }
  }

  function isHttp(s) {
    return typeof s === 'string'
      && /^https?:\/\/[a-zA-Z0-9\-]+(\.[a-zA-Z0-9\-]+)+/.test(s.trim());
  }

  function isOffsite(url) {
    const h = hostOf(url);
    return h && h !== currentHost && !isTrusted(h);
  }

  function extractUrl(raw) {
    if (!raw || typeof raw !== 'string' || raw.trim().length < 8) return null;
    const t = raw.trim();
    try {
      const plain = decodeURIComponent(t);
      if (isHttp(plain) && isOffsite(plain)) return plain;
    } catch {}
    const b1 = b64decode(t);
    if (b1) {
      if (isHttp(b1) && isOffsite(b1)) return b1;
      try {
        const obj = JSON.parse(b1);
        for (const k of ['url','link','linkr','redirect','href','dest','u','r','go']) {
          if (obj[k] && isHttp(obj[k]) && isOffsite(obj[k])) return obj[k];
        }
      } catch {}
      const b2 = b64decode(b1.trim());
      if (b2 && isHttp(b2) && isOffsite(b2)) return b2;
    }
    return null;
  }

  // ─── Navigate ────────────────────────────────────────────────────────────────
  let navigated = false;

  function navigate(destUrl) {
    if (navigated) return;
    navigated = true;
    try { sessionStorage.setItem(STORAGE_KEY, destUrl); } catch {}
    chrome.runtime.sendMessage({ type: 'JS_REDIRECT_FOUND', sourceHost: currentHost, destUrl });
    try { window.location.replace(destUrl); }
    catch { window.location.href = destUrl; }
  }

  // ─── 1. Background message (302 chain result) ─────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'BYPASS_REDIRECT' && isHttp(msg.url) && isOffsite(msg.url)) {
      if (navigated) return;
      navigated = true;
      try { sessionStorage.setItem(STORAGE_KEY, msg.url); } catch {}
      try { window.location.replace(msg.url); }
      catch { window.location.href = msg.url; }
    }
  });

  // ─── 2. Timer acceleration — inject into page scope ───────────────────────────
  // Overrides setTimeout/setInterval so countdowns expire immediately.
  // Injected as a real <script> tag so it runs in the page's JS context.
  function injectTimerAccelerator() {
    const script = document.createElement('script');
    script.textContent = `(function(){
      // Preserve originals
      const _st = window.setTimeout;
      const _si = window.setInterval;
      const _now = Date.now;
      const _perf = performance.now.bind(performance);

      // Fire timers immediately (0ms) — countdown JS will think time has passed
      window.setTimeout = function(fn, delay) {
        return _st(fn, 0);
      };

      // For setInterval, fire once immediately then keep at 50ms
      // (many sites use setInterval to decrement a counter each second)
      window.setInterval = function(fn, delay) {
        _st(fn, 0); // fire now
        return _si(fn, 50); // then fast
      };

      // Spoof Date.now to return a time far in the future
      // so timestamp-based countdowns (endTime - now) go to 0 or negative
      const FUTURE = _now() + 86400000; // +24h
      Date.now = function() { return FUTURE; };
      performance.now = function() { return _perf() + 86400000; };
    })();`;
    (document.documentElement || document.head || document.body || document).appendChild(script);
    script.remove();
  }

  // Inject as early as possible
  if (document.readyState === 'loading') {
    // document_start — documentElement exists but head/body may not
    injectTimerAccelerator();
  }

  // ─── 3. URL extraction — query params ────────────────────────────────────────
  (function tryQueryParams() {
    try {
      const params = new URL(location.href).searchParams;
      const keys = ['safelink','wpsafelink','newwpsafelink','linkr',
                    'url','link','goto','redirect','destination','out',
                    'forward','dest','file','dl','download'];
      for (const key of keys) {
        const found = extractUrl(params.get(key));
        if (found) { navigate(found); return; }
      }
    } catch {}
  })();

  // ─── 4. DOM scan + button clicker ────────────────────────────────────────────

  // Known "Get Link" / continue button selectors from real shortlink sites.
  // Ordered by specificity — more specific ones first.
  const BUTTON_SELECTORS = [
    // wpSafeLink / newwpsafelink
    '#wpsafelinkhuman > img',
    '#wpsafelinkhuman',
    'button#btn6.yu-btn.yu-go',
    '#yuidea-btn-after.yu-blue.yu-btn',
    '#yuidea-btn-before.yu-btn.yu-blue',
    '.yu-blue.yu-btn',
    // GPlinks / Just2Earn / common patterns
    'a.btn-main.get-link',
    'a.get-link.btn-lg.btn-success',
    'a.get-link.btn-success',
    '.get-link.btn',
    'a.get-link',
    '#get-link',
    // AdLinkFly / exe.io / fc.lc / similar platforms
    'button#btn_download',
    'a#btn_download',
    '#go-link',
    'a#go-link',
    '#showTimerText',
    'button#showTimerText',
    'a#firststep-btn.btn.btnstep1',
    'a#finalx22.btn.btnstep1',
    '#url_qu > a',
    // shrinkme / short.pe / generic countdown
    '.skip-btn',
    '#skip-btn',
    'a.skip',
    '#skip',
    '.btn-skip',
    // droplink / link1s
    '#btn-main',
    'a#btn-main',
    '.main-btn',
    '#main-btn',
    // OUO / bc.vc style
    '#continue-btn',
    'a#continue-btn',
    'button.continue-btn',
    // countdown complete → reveal link
    '#link-view a',
    '#reveal-btn',
    '.reveal-btn',
    // Generic fallback class patterns
    'a.btn-success[href]:not([href="#"]):not([href="javascript"])',
    'a.btn-primary[href]:not([href="#"]):not([href="javascript"])',
  ];

  // Heuristic text-based button finder for unknown sites
  const BTN_TEXT_RE = /^\s*(get\s*(link|file|download)|skip\s*(ad)?|continue|proceed|go\s*to\s*link|download\s*now|click\s*here)\s*$/i;

  function findButtonToClick() {
    // Try specific selectors first
    for (const sel of BUTTON_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) return el;
      } catch {}
    }

    // Heuristic: any visible <a> or <button> whose text matches
    const candidates = document.querySelectorAll('a[href],button,input[type="button"],input[type="submit"]');
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || el.value || '').trim();
      if (BTN_TEXT_RE.test(text)) return el;
    }

    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    } catch {}
    return true;
  }

  function clickButton(el) {
    if (!el || navigated) return false;
    // If it's a link with a real offsite href, navigate directly
    if (el.tagName === 'A') {
      try {
        const href = new URL(el.getAttribute('href') || '', location.href).href;
        if (isOffsite(href)) {
          navigate(href);
          return true;
        }
      } catch {}
    }
    // Otherwise simulate a click (will trigger JS handlers / form submit)
    try { el.click(); return true; } catch {}
    return false;
  }

  // ─── DOM scan — URL extraction + button click ─────────────────────────────────
  function domScan() {
    if (navigated) return;

    // 4a. Named safelink inputs
    const SAFELINK_INPUTS = [
      'input[name="wpsafelink"]','input[name="safelink"]',
      'input[name="newwpsafelink"]','input[name="safelink_redirect"]',
      'input[name="linkr"]',
    ];
    for (const sel of SAFELINK_INPUTS) {
      for (const el of document.querySelectorAll(sel)) {
        const found = extractUrl(el.value);
        if (found) { navigate(found); return; }
      }
    }

    // 4b. Any hidden input decoding to offsite URL
    for (const el of document.querySelectorAll('input[type="hidden"]')) {
      if (!el.value || el.value.length < 16) continue;
      const found = extractUrl(el.value);
      if (found) { navigate(found); return; }
    }

    // 4c. data-* attributes
    for (const attr of ['data-url','data-href','data-link','data-redirect','data-dest']) {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        const found = extractUrl(el.getAttribute(attr));
        if (found) { navigate(found); return; }
      }
    }

    // 4d. Meta refresh
    for (const m of document.querySelectorAll('meta[http-equiv="refresh" i]')) {
      const match = (m.getAttribute('content') || '').match(/url\s*=\s*['"]?([^'">\s]+)/i);
      if (match) {
        const found = extractUrl(match[1]);
        if (found) { navigate(found); return; }
      }
    }

    // 4e. Inline scripts — strict safelink var names + location assignments
    const STRICT_RE   = /\b(wpsafelink|safelink|linkr|newwpsafelink|safelink_redirect)\s*=\s*['"`]([A-Za-z0-9+/=_\-]{20,})['"`]/gi;
    const LOCATION_RE = /(?:window\.location(?:\.href)?|location\.href|location\.replace\s*\()\s*[=(]\s*['"`](https?:\/\/[^'"` \n]{10,})['"`]/gi;
    for (const sc of document.querySelectorAll('script:not([src])')) {
      const text = sc.textContent;
      STRICT_RE.lastIndex = 0;
      let m;
      while ((m = STRICT_RE.exec(text)) !== null) {
        const found = extractUrl(m[2]);
        if (found) { navigate(found); return; }
      }
      LOCATION_RE.lastIndex = 0;
      while ((m = LOCATION_RE.exec(text)) !== null) {
        const found = extractUrl(m[1]);
        if (found) { navigate(found); return; }
      }
    }

    // 4f. Try clicking a "Get Link" button if one is visible
    const btn = findButtonToClick();
    if (btn) {
      clickButton(btn);
      return;
    }

    // 4g. Offsite anchors with get-link intent text — report only
    const LINK_TEXT = /\b(get.?link|direct.?link|skip.?ad|get.?file)\b/i;
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const href = new URL(a.getAttribute('href'), location.href).href;
        if (!isOffsite(href)) continue;
        if (LINK_TEXT.test(a.textContent) || LINK_TEXT.test(a.className)) {
          chrome.runtime.sendMessage({ type: 'JS_REDIRECT_FOUND', sourceHost: currentHost, destUrl: href });
          return;
        }
      } catch {}
    }
  }

  // ─── 5. Run immediately + watch DOM ──────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', domScan, { once: true });
  } else {
    domScan();
  }

  // MutationObserver: re-scan when DOM changes (buttons appear after timer)
  const observer = new MutationObserver(() => { if (!navigated) domScan(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 30000);

})();
