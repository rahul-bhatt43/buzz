const search = require('./search');

const NEW_TAB_URL = 'buzz://newtab/';

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isWebUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

function isInternalUrl(url) {
  return /^buzz:\/\//i.test(url || '');
}

// The buzz:// page name ("settings", "newtab"...), or '' for anything else.
function internalPage(url) {
  if (!isInternalUrl(url)) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// Hosts that never get an HTTPS upgrade: loopback, private ranges and local names.
function isLocalHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h.includes(':')) return h === '::1' || /^(fe80|f[cd])/.test(h);
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

// The URL typed text stands for, or null when it reads as a search query.
function typedUrl(input) {
  const text = (input || '').trim();
  if (!text) return null;
  if (/^(https?|file|buzz):\/\//i.test(text)) return text;
  if (/\s/.test(text)) return null;
  const hostPart = text.split(/[/?#]/)[0];
  const bareHost = hostPart.replace(/:\d+$/, '');
  if (isLocalHost(bareHost)) return 'http://' + text;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(bareHost)) return 'https://' + text;
  return null;
}

// Turn whatever was typed in the address bar into a URL to load.
function fromAddressInput(input) {
  const text = (input || '').trim();
  if (!text) return null;
  return typedUrl(text) || search.searchUrl(text);
}

// What the address bar shows for a given tab URL. Internal pages that stand in
// for a website (reader, warnings) show that website's address.
function describeUrl(url) {
  if (!isInternalUrl(url)) {
    const secure = url && (url.startsWith('https://') || hostOf(url).endsWith('.onion'));
    return { displayUrl: url || '', kind: secure ? 'secure' : isWebUrl(url) ? 'insecure' : 'internal' };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { displayUrl: '', kind: 'internal' };
  }
  const target = parsed.searchParams.get('url') || '';
  if (parsed.hostname === 'reader') return { displayUrl: target, kind: 'reader' };
  if (parsed.hostname === 'insecure') return { displayUrl: target, kind: 'insecure' };
  if (parsed.hostname === 'error') return { displayUrl: target, kind: 'internal' };
  if (parsed.hostname === 'newtab') return { displayUrl: '', kind: 'internal' };
  return { displayUrl: `buzz://${parsed.hostname}`, kind: 'internal' };
}

module.exports = { NEW_TAB_URL, hostOf, isWebUrl, isInternalUrl, internalPage, isLocalHost, typedUrl, fromAddressInput, describeUrl };
