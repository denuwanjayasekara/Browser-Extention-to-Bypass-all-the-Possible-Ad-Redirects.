// content.js — runs at document_start

(function () {
  'use strict';

  // ─── Trusted domains — exit immediately ──────────────────────────────────────
  const TRUSTED = [
    'google.com','googleapis.com','gstatic.com','youtube.com','gmail.com',
    'github.com','github.io','githubusercontent.com',
    'microsoft.com','live.com','office.com','outlook.com','bing.com',
    'apple.com','icloud.com','amazon.com','aws.amazon.com',
    // Social sharing widgets — these embed ?url= params but are NOT ad pages
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

  // Hard exit on trusted sites
  if (isTrusted(hostOf(location.href))) return;

  // ─── Loop guard ───────────────────────────────────────────────────────────────
  // Read the host we just came from (set via sessionStorage by navigate()).
  // If the page we're on now IS the previous destination, we looped — stop.
  const STORAGE_KEY = 'adbypass_last_dest';
  const currentHost = hostOf(location.href);
  try {
    const lastDest = sessionStorage.getItem(STORAGE_KEY);
    if (lastDest && hostOf(lastDest) === currentHost) {
      // We navigated here as a bypass destination — clear and stop processing
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

    // Store destination so if we land there and it tries to redirect back, we stop
    try { sessionStorage.setItem(STORAGE_KEY, destUrl); } catch {}

    chrome.runtime.sendMessage({
      type: 'JS_REDIRECT_FOUND',
      sourceHost: currentHost,
      destUrl,
    });

    try { window.location.replace(destUrl); }
    catch { window.location.href = destUrl; }
  }

  // ─── 1. Receive 302-chain result from background.js ──────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'BYPASS_REDIRECT' && isHttp(msg.url) && isOffsite(msg.url)) {
      if (navigated) return;
      navigated = true;
      try { sessionStorage.setItem(STORAGE_KEY, msg.url); } catch {}
      try { window.location.replace(msg.url); }
      catch { window.location.href = msg.url; }
    }
  });

  // ─── 2. Query params ─────────────────────────────────────────────────────────
  const SAFELINK_PARAMS = [
    'safelink','wpsafelink','newwpsafelink','linkr',
    'url','link','goto','redirect','destination','out','forward','dest',
    'file','dl','download',
  ];

  (function tryQueryParams() {
    try {
      const params = new URL(location.href).searchParams;
      for (const key of SAFELINK_PARAMS) {
        const found = extractUrl(params.get(key));
        if (found) { navigate(found); return; }
      }
    } catch {}
  })();

  // ─── 3. DOM scan ─────────────────────────────────────────────────────────────
  function domScan() {
    if (navigated) return;

    // 3a. Known safelink hidden inputs
    const SAFELINK_INPUTS = [
      'input[name="wpsafelink"]',
      'input[name="safelink"]',
      'input[name="newwpsafelink"]',
      'input[name="safelink_redirect"]',
      'input[name="linkr"]',
    ];
    for (const sel of SAFELINK_INPUTS) {
      for (const el of document.querySelectorAll(sel)) {
        const found = extractUrl(el.value);
        if (found) { navigate(found); return; }
      }
    }

    // 3b. Any hidden input whose value decodes to an offsite URL
    for (const el of document.querySelectorAll('input[type="hidden"]')) {
      if (!el.value || el.value.length < 16) continue;
      const found = extractUrl(el.value);
      if (found) { navigate(found); return; }
    }

    // 3c. data-* attributes
    for (const attr of ['data-url','data-href','data-link','data-redirect','data-dest']) {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        const found = extractUrl(el.getAttribute(attr));
        if (found) { navigate(found); return; }
      }
    }

    // 3d. Meta refresh
    for (const m of document.querySelectorAll('meta[http-equiv="refresh" i]')) {
      const match = (m.getAttribute('content') || '').match(/url\s*=\s*['"]?([^'">\s]+)/i);
      if (match) {
        const found = extractUrl(match[1]);
        if (found) { navigate(found); return; }
      }
    }

    // 3e. Inline scripts — strict safelink variable names only
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

    // 3f. Offsite anchors with get-link intent — report only
    const LINK_TEXT = /\b(get.?link|direct.?link|skip.?ad|get.?file)\b/i;
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const href = new URL(a.getAttribute('href'), location.href).href;
        if (!isOffsite(href)) continue;
        if (LINK_TEXT.test(a.textContent) || LINK_TEXT.test(a.className)) {
          chrome.runtime.sendMessage({
            type: 'JS_REDIRECT_FOUND',
            sourceHost: currentHost,
            destUrl: href,
          });
          return;
        }
      } catch {}
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', domScan, { once: true });
  } else {
    domScan();
  }

  const observer = new MutationObserver(() => { if (!navigated) domScan(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 20000);

})();
