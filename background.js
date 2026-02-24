// background.js - MV3 Service Worker

// ─── Seed list ────────────────────────────────────────────────────────────────
const SEED_HOSTS = new Set([
  'psa.wf','ouo.io','ouo.press','adshrink.it','shorte.st','adf.ly',
  'linkvertise.com','link-to.net','lnk.bio','bc.vc','sh.st','exe.io',
  'fc.lc','shrinkearn.com','droplink.co','gplinks.in','mdiskshort.com',
  'za.gl','du.gl','ay.link','link1s.com','shrinkme.io','short.pe',
  'cutlink.net','shrinkforearn.in','earnload.xyz',
]);

let knownAdHosts = new Set(SEED_HOSTS);

async function loadLearnedHosts() {
  const data = await chrome.storage.local.get('learnedHosts');
  (data.learnedHosts || []).forEach(h => knownAdHosts.add(h));
}

async function saveLearnedHost(host) {
  host = (host || '').replace(/^www\./, '').toLowerCase().trim();
  if (!host || host.length < 4) return;
  if (knownAdHosts.has(host)) return;
  if (isTrustedHost(host)) return;
  knownAdHosts.add(host);
  const data = await chrome.storage.local.get('learnedHosts');
  const learned = data.learnedHosts || [];
  if (!learned.includes(host)) {
    learned.push(host);
    await chrome.storage.local.set({ learnedHosts: learned });
    console.log('[AdBypass] ✅ Learned:', host);
  }
}

async function removeLearnedHost(host) {
  knownAdHosts.delete(host);
  const data = await chrome.storage.local.get('learnedHosts');
  const learned = (data.learnedHosts || []).filter(h => h !== host);
  await chrome.storage.local.set({ learnedHosts: learned });
  console.log('[AdBypass] ❌ Removed:', host);
}

loadLearnedHosts();

// ─── Trusted hosts — never learn, never navigate away from, never navigate TO ─
// These are legitimate sites that may have redirect-style URLs but are NOT ad pages.
const TRUSTED_HOSTS = [
  // Search & Google
  'google.com','googleapis.com','gstatic.com','youtube.com','gmail.com',
  // Social sharing widgets — these embed ?url= params legitimately
  'tumblr.com','twitter.com','x.com','facebook.com','instagram.com',
  'linkedin.com','pinterest.com','reddit.com','redd.it','whatsapp.com',
  'telegram.org','t.me',
  // Dev & tech
  'github.com','github.io','githubusercontent.com',
  'stackoverflow.com','stackexchange.com','cloudflare.com',
  // Microsoft
  'microsoft.com','live.com','office.com','outlook.com','bing.com',
  // Apple / Amazon
  'apple.com','icloud.com','amazon.com','aws.amazon.com',
  // Wikis
  'wikipedia.org','wikimedia.org',
  // Other major
  'yahoo.com','duckduckgo.com','netflix.com','spotify.com',
  'dropbox.com','paypal.com','stripe.com',
];

function getHost(urlStr) {
  try { return new URL(urlStr).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return null; }
}

function isTrustedHost(h) {
  if (!h) return false;
  return TRUSTED_HOSTS.some(t => h === t || h.endsWith('.' + t));
}

function isValidHttpUrl(urlStr) {
  try { const u = new URL(urlStr); return u.protocol === 'https:' || u.protocol === 'http:'; }
  catch { return false; }
}

// ─── Loop detection ───────────────────────────────────────────────────────────
// Track recent bypass destinations per tab. If we'd navigate to a URL whose
// host we already navigated FROM recently, it's a loop — abort and un-learn.
//
// Map<tabId, { hosts: Set<string>, timer: number }>
const tabHistory = new Map();
const LOOP_WINDOW_MS = 10000; // reset history after 10s of no activity

function recordBypass(tabId, fromHost, toHost) {
  if (!tabHistory.has(tabId)) {
    tabHistory.set(tabId, { hosts: new Set(), timer: null });
  }
  const entry = tabHistory.get(tabId);
  clearTimeout(entry.timer);
  entry.hosts.add(fromHost);
  entry.timer = setTimeout(() => tabHistory.delete(tabId), LOOP_WINDOW_MS);
  return entry.hosts;
}

function wouldLoop(tabId, toHost) {
  const entry = tabHistory.get(tabId);
  return entry ? entry.hosts.has(toHost) : false;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const e = tabHistory.get(tabId);
  if (e) clearTimeout(e.timer);
  tabHistory.delete(tabId);

  const c = chains.get(tabId);
  if (c) clearTimeout(c.timer);
  chains.delete(tabId);
});

// ─── Safe dispatch ────────────────────────────────────────────────────────────
function dispatchFinalUrl(tabId, sourceHost, finalUrl) {
  if (!isValidHttpUrl(finalUrl)) return;

  const destHost = getHost(finalUrl);

  // Never navigate to trusted sites
  if (isTrustedHost(destHost)) return;

  // Loop detection: if destination host is in our recent bypass history, stop
  if (wouldLoop(tabId, destHost)) {
    console.warn('[AdBypass] ⚠️ Loop detected:', sourceHost, '→', destHost, '— aborting and un-learning source');
    // Un-learn the source host — it was incorrectly learned
    removeLearnedHost(sourceHost);
    tabHistory.delete(tabId);
    return;
  }

  // Record this bypass attempt
  recordBypass(tabId, sourceHost, destHost);

  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    const tabHost = getHost(tab.url || '');
    if (isTrustedHost(tabHost)) return;
    const onAdHost = knownAdHosts.has(tabHost);
    const isLoading = tab.status === 'loading';
    if (!onAdHost && !isLoading) return;

    chrome.tabs.sendMessage(tabId, { type: 'BYPASS_REDIRECT', url: finalUrl }, () => {
      if (chrome.runtime.lastError) {
        chrome.tabs.get(tabId, (t2) => {
          if (chrome.runtime.lastError || !t2) return;
          if (!isTrustedHost(getHost(t2.url || ''))) {
            chrome.tabs.update(tabId, { url: finalUrl });
          }
        });
      }
    });
  });
}

// ─── 302 redirect chain tracking ─────────────────────────────────────────────
const chains = new Map();

function scheduleFlush(tabId) {
  const entry = chains.get(tabId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    const e = chains.get(tabId);
    if (!e) return;
    chains.delete(tabId);

    const chain = e.chain;
    if (chain.length < 2) return;

    const startHost = getHost(chain[0]);
    const finalUrl  = chain[chain.length - 1];
    const finalHost = getHost(finalUrl);

    if (!startHost || !finalHost || startHost === finalHost) return;
    if (isTrustedHost(startHost)) return;

    if (chain.length >= 3) await saveLearnedHost(startHost);

    if (knownAdHosts.has(startHost)) {
      dispatchFinalUrl(tabId, startHost, finalUrl);
    }
  }, 350);
}

chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (details.type !== 'main_frame' || !details.tabId || details.tabId < 0) return;
    const { tabId, url, redirectUrl } = details;
    if (isTrustedHost(getHost(url))) return;
    if (!chains.has(tabId)) chains.set(tabId, { chain: [url], timer: null });
    chains.get(tabId).chain.push(redirectUrl);
    scheduleFlush(tabId);
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.type !== 'main_frame' || !details.tabId) return;
    if (chains.has(details.tabId)) scheduleFlush(details.tabId);
  },
  { urls: ['<all_urls>'] }
);

// ─── Messages from content.js ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'JS_REDIRECT_FOUND' && sender.tab) {
    sendResponse({ ok: true });
    const sourceHost = (msg.sourceHost || '').replace(/^www\./, '').toLowerCase();
    const destUrl = msg.destUrl;
    const destHost = getHost(destUrl);

    if (isTrustedHost(sourceHost)) return;
    if (!destUrl || !isValidHttpUrl(destUrl)) return;
    if (!destHost || sourceHost === destHost) return;

    // Loop check before learning: if dest host is also in knownAdHosts,
    // this is likely two ad sites pointing at each other — don't learn either
    if (knownAdHosts.has(destHost)) {
      console.warn('[AdBypass] ⚠️ Dest is already an ad host, skipping learn:', sourceHost, '→', destHost);
      return;
    }

    saveLearnedHost(sourceHost);

    if (!isTrustedHost(destHost)) {
      dispatchFinalUrl(sender.tab.id, sourceHost, destUrl);
    }
  }

  if (msg.type === 'GET_HOSTS') {
    chrome.storage.local.get('learnedHosts', (data) => {
      sendResponse({ seed: [...SEED_HOSTS], learned: data.learnedHosts || [] });
    });
    return true;
  }

  if (msg.type === 'REMOVE_HOST') {
    removeLearnedHost(msg.host).then(() => sendResponse({ ok: true }));
    return true;
  }
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => clients.claim());
