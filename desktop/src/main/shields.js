// Buzz Shields: ad & tracker blocking plus automatic HTTPS upgrades.
const { app, ipcMain, webContents } = require('electron');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { ElectronBlocker, Request } = require('@ghostery/adblocker-electron');
const settings = require('./settings');
const { hostOf, isWebUrl, isInternalUrl, isLocalHost } = require('./urls');

const ENGINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

const events = new EventEmitter();
let blocker = null;
let engineState = 'loading'; // loading | ready | unavailable

const blockedByTab = new Map(); // webContents id -> requests blocked on the current page
const upgradedByTab = new Map(); // webContents id -> { host, httpUrl } of the last HTTPS upgrade
const insecureAllowed = new Set(); // hosts the user chose to open over HTTP (this run only)

async function loadEngine() {
  const cache = path.join(app.getPath('userData'), 'adblock-engine.bin');
  try {
    // Drop a stale cache so the filter lists get refreshed about once a week.
    const age = Date.now() - fs.statSync(cache).mtimeMs;
    if (age > ENGINE_MAX_AGE_MS) fs.unlinkSync(cache);
  } catch {
    // No cache yet.
  }
  try {
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    engineState = 'ready';
  } catch (err) {
    console.error('Filter lists could not be loaded:', err.message);
    engineState = 'unavailable';
    setTimeout(loadEngine, RETRY_MS).unref();
  }
  events.emit('change');
}

function isSiteEnabled(host) {
  return !settings.get('shieldsOffHosts').includes(host);
}

function setSiteEnabled(host, enabled) {
  if (!host) return;
  const hosts = settings.get('shieldsOffHosts').filter((h) => h !== host);
  if (!enabled) hosts.push(host);
  settings.set('shieldsOffHosts', hosts);
}

function blockingActiveFor(pageUrl) {
  return engineState === 'ready' && settings.get('adblock') && isWebUrl(pageUrl) && isSiteEnabled(hostOf(pageUrl));
}

// The page a request belongs to: the tab's current URL, or the referrer for
// requests with no tab (service workers).
function pageUrlFor(details) {
  if (details.webContentsId) {
    const wc = webContents.fromId(details.webContentsId);
    if (wc && !wc.isDestroyed()) {
      const url = wc.getURL();
      if (url) return url;
    }
  }
  return details.referrer || '';
}

function countBlocked(details) {
  if (details.webContentsId) {
    blockedByTab.set(details.webContentsId, (blockedByTab.get(details.webContentsId) || 0) + 1);
  }
  settings.set('totalBlocked', settings.get('totalBlocked') + 1, { silent: true });
  events.emit('change');
}

function upgradeTarget(details) {
  if (!settings.get('httpsUpgrade') || details.resourceType !== 'mainFrame') return null;
  if (!details.url.startsWith('http://')) return null;
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return null;
  }
  // Only the default port is upgraded; a custom port rarely serves TLS as well.
  // .onion services are encrypted end to end by Tor itself and usually have no HTTPS.
  if (url.port || isLocalHost(url.hostname) || url.hostname.endsWith('.onion') || insecureAllowed.has(url.hostname)) return null;
  if (details.webContentsId) {
    upgradedByTab.set(details.webContentsId, { host: url.hostname, httpUrl: details.url });
  }
  url.protocol = 'https:';
  return url.href;
}

function onBeforeRequest(details, callback) {
  const upgraded = upgradeTarget(details);
  if (upgraded) {
    callback({ redirectURL: upgraded });
    return;
  }
  if (details.resourceType === 'mainFrame' || !/^(https?|wss?):/i.test(details.url)) {
    callback({});
    return;
  }
  const pageUrl = pageUrlFor(details);
  if (isInternalUrl(pageUrl) || !blockingActiveFor(pageUrl)) {
    callback({});
    return;
  }
  const raw = { requestId: `${details.id}`, sourceUrl: pageUrl, type: details.resourceType || 'other', url: details.url };
  if (details.webContentsId) raw.tabId = details.webContentsId;
  const request = Request.fromRawDetails(raw);
  if (blocker.config.guessRequestTypeFromUrl === true && request.type === 'other') {
    request.guessTypeOfRequest();
  }
  const { redirect, match } = blocker.match(request);
  if (redirect) {
    countBlocked(details);
    callback({ redirectURL: redirect.dataUrl });
  } else if (match) {
    countBlocked(details);
    callback({ cancel: true });
  } else {
    callback({});
  }
}

function onHeadersReceived(details, callback) {
  const pageUrl = details.resourceType === 'mainFrame' ? details.url : pageUrlFor(details);
  if (!blockingActiveFor(pageUrl)) {
    callback({});
    return;
  }
  blocker.onHeadersReceived(details, callback);
}

// Cosmetic filtering (hiding leftover ad slots) is driven by the engine's
// preload script, which asks the main process what to hide on each frame.
function registerCosmeticHandlers() {
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url, msg) => {
    if (!blockingActiveFor(event.sender.getURL())) return undefined;
    return blocker.onInjectCosmeticFilters(event, url, msg);
  });
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', () => {
    return blocker ? blocker.config.enableMutationObserver : false;
  });
}

function attachToSession(ses) {
  ses.registerPreloadScript({
    type: 'frame',
    filePath: require.resolve('@ghostery/adblocker-electron-preload'),
  });
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, onBeforeRequest);
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, onHeadersReceived);
}

function init() {
  registerCosmeticHandlers();
  settings.on('change', () => events.emit('change'));
  loadEngine();
}

module.exports = {
  events,
  init,
  attachToSession,
  isSiteEnabled,
  setSiteEnabled,
  engineState: () => engineState,
  ready: () => engineState === 'ready',
  blockedOn: (wcId) => blockedByTab.get(wcId) || 0,
  resetTab: (wcId) => blockedByTab.delete(wcId),
  forgetTab: (wcId) => {
    blockedByTab.delete(wcId);
    upgradedByTab.delete(wcId);
  },
  // If `failedUrl` is an HTTPS upgrade we made in this tab, return the original HTTP URL.
  upgradeFallback: (wcId, failedUrl) => {
    const entry = upgradedByTab.get(wcId);
    if (!entry || !failedUrl.startsWith('https://')) return null;
    try {
      return new URL(failedUrl).hostname === entry.host ? entry.httpUrl : null;
    } catch {
      return null;
    }
  },
  allowInsecure: (hostname) => insecureAllowed.add(hostname),
};
