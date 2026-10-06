// Internal buzz:// pages. Two kinds:
//  - static pages (new tab, reader, warnings) that run no scripts at all;
//  - app pages (settings, history, downloads) that run Buzz's own scripts and
//    talk to the main process through src/pages/preload.js.
const fs = require('node:fs');
const path = require('node:path');
const reader = require('./reader');
const search = require('./search');
const settings = require('./settings');
const store = require('./store');
const { isWebUrl, hostOf } = require('./urls');

const ASSETS_DIR = path.join(__dirname, '../assets');
const PAGES_DIR = path.join(__dirname, '../pages');
const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };

const APP_PAGES = { settings: 'Settings', history: 'History', downloads: 'Downloads' };
// Pages allowed to link to other buzz:// pages (the reader shows untrusted content, so it is not).
const TRUSTED_PAGES = new Set(['newtab', ...Object.keys(APP_PAGES)]);

const COMMON_CSP = "default-src 'none'; style-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'";
const STATIC_CSP = `${COMMON_CSP}; img-src 'self' data:`;
const APP_CSP = `${COMMON_CSP}; img-src 'self' data:; script-src 'self'; form-action 'none'`;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function serveFile(dir, relative) {
  const file = path.resolve(dir, relative);
  const type = MIME[path.extname(file)];
  if (!type || !file.startsWith(dir + path.sep) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { 'content-type': type, 'cache-control': 'no-cache' } });
}

function htmlAttributes(isPrivate, extra = '') {
  return [
    `data-scheme="${settings.get('scheme')}"`,
    `data-font="${settings.get('uiFont')}"`,
    `data-reader-font="${settings.get('readerFont')}"`,
    `data-reader-size="${settings.get('readerSize')}"`,
    isPrivate ? 'class="private"' : '',
    extra,
  ].join(' ');
}

function page(body, { title, csp = STATIC_CSP, isPrivate = false, status = 200, lang = 'en', dir = '', bodyAttributes = '' }) {
  const doc = `<!doctype html>
<html lang="${escapeHtml(lang)}"${dir ? ` dir="${escapeHtml(dir)}"` : ''} ${htmlAttributes(isPrivate)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/assets/theme.css">
<link rel="stylesheet" href="/pages.css">
</head>
<body ${bodyAttributes}>${body}</body>
</html>`;
  return new Response(doc, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, 'cache-control': 'no-store' },
  });
}

const LOGO = '<img class="mark" src="/assets/logo.svg" alt="">';

function notice({ title, heading, paragraphs, actions = '', isPrivate, status = 200 }) {
  const body = `<main class="notice">
    ${LOGO}
    <h1>${heading}</h1>
    ${paragraphs.map((p) => `<p>${p}</p>`).join('\n')}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
  </main>`;
  return page(body, { title, isPrivate, status });
}

function greeting(hour) {
  if (hour < 5 || hour >= 22) return 'Up late.';
  if (hour < 12) return 'Good morning.';
  if (hour < 17) return 'Good afternoon.';
  return 'Good evening.';
}

// A stable 0-11 bucket per host, so each site keeps its tile colour.
function hueBucket(text) {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % 12;
}

function newTabPage(isPrivate) {
  const engine = search.current();
  const { action, origin, param } = search.form();
  const now = new Date();
  const sites = isPrivate ? [] : store.topSites(8);
  const tiles = sites
    .map(
      (site) => `<a class="site hue-${hueBucket(site.host)}" href="${escapeHtml(site.url)}">
        <span class="avatar">${escapeHtml(site.host[0].toUpperCase())}</span>
        <span class="site-name">${escapeHtml(site.host)}</span>
      </a>`,
    )
    .join('');
  const blocked = new Intl.NumberFormat().format(settings.get('totalBlocked'));
  const body = `<div class="comb" aria-hidden="true"></div>
  <main class="newtab">
    <p class="date">${escapeHtml(now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
    <h1 class="greeting">${isPrivate ? 'Private window.' : greeting(now.getHours())}</h1>
    <form class="search" action="${escapeHtml(action)}" method="get" role="search">
      <input name="${escapeHtml(param)}" type="search" placeholder="Search with ${escapeHtml(engine.name)}" aria-label="Search the web" autocomplete="off" autofocus>
      <button type="submit">Search</button>
    </form>
    ${
      isPrivate
        ? '<p class="private-note">Buzz forgets this window\'s history, cookies and site data when you close it. Downloads you keep stay on disk, and your network and the sites you visit can still see your activity.</p>'
        : ''
    }
    ${tiles ? `<section class="sites" aria-label="Most visited">${tiles}</section>` : ''}
    <footer class="stats">
      <div class="stat"><strong>${blocked}</strong><span>ads &amp; trackers blocked</span></div>
      <nav class="quick" aria-label="Buzz pages">
        <a href="buzz://history/">History</a>
        <a href="buzz://downloads/">Downloads</a>
        <a href="buzz://settings/">Settings</a>
      </nav>
    </footer>
  </main>`;
  return page(body, {
    title: isPrivate ? 'New Private Tab' : 'New Tab',
    csp: `${STATIC_CSP}; form-action ${origin}`,
    isPrivate,
    bodyAttributes: 'class="newtab-body"',
  });
}

function insecurePage(target, isPrivate) {
  if (!isWebUrl(target)) return notFound(isPrivate);
  const proceed = 'buzz://insecure/proceed?url=' + encodeURIComponent(target);
  return notice({
    title: 'Connection is not secure',
    heading: 'This site does not support a secure connection',
    paragraphs: [
      `Buzz tried to upgrade <strong>${escapeHtml(hostOf(target))}</strong> to HTTPS, but the site did not respond securely.`,
      'Over plain HTTP, anyone on your network can read or change what you send and receive. Avoid entering passwords or payment details.',
    ],
    actions: `<a class="button" href="${escapeHtml(proceed)}">Continue to the HTTP site</a>`,
    isPrivate,
  });
}

function errorPage(target, reason, isPrivate) {
  return notice({
    title: 'Page could not be loaded',
    heading: 'This page could not be loaded',
    paragraphs: [
      `<strong>${escapeHtml(hostOf(target) || target)}</strong> did not load. Check the address and your internet connection.`,
      `<small>${escapeHtml(reason)}</small>`,
    ],
    actions: isWebUrl(target) ? `<a class="button primary" href="${escapeHtml(target)}">Try again</a>` : '',
    isPrivate,
  });
}

function readerPage(ses, target, isPrivate) {
  const article = isWebUrl(target) ? reader.get(ses, target) : null;
  if (!article) {
    return notice({
      title: 'Reader view',
      heading: 'The reader view for this page has expired',
      paragraphs: ['Open the original page and switch reader mode on again.'],
      actions: isWebUrl(target) ? `<a class="button primary" href="${escapeHtml(target)}">Open the original page</a>` : '',
      isPrivate,
    });
  }
  const minutes = Math.max(1, Math.round((article.length || 0) / 1100));
  const meta = [article.byline, `${minutes} min read`].filter(Boolean).map(escapeHtml).join(' &middot; ');
  // article.content comes from the page and is untrusted; the CSP keeps it
  // inert (no scripts, inline handlers, inline styles, forms or frames).
  const body = `<main class="reader">
    <div class="site-label">${escapeHtml(article.siteName || hostOf(target))}</div>
    <h1>${escapeHtml(article.title || hostOf(target))}</h1>
    <div class="meta">${meta}</div>
    <div class="article">${article.content}</div>
  </main>`;
  return page(body, {
    title: article.title || 'Reader view',
    csp: `${COMMON_CSP}; img-src 'self' https: data:; media-src https:; form-action 'none'`,
    isPrivate,
    lang: article.lang || 'en',
    dir: article.dir || '',
  });
}

function appPage(name, isPrivate) {
  const links = Object.entries(APP_PAGES)
    .map(([id, label]) => `<a href="buzz://${id}/"${id === name ? ' aria-current="page"' : ''}><span class="icon" data-icon="${id}"></span>${label}</a>`)
    .join('');
  const body = `<nav class="rail" aria-label="Buzz pages">
    <a class="rail-brand" href="buzz://newtab/">${LOGO}<span class="wordmark">Buzz</span></a>
    ${links}
  </nav>
  <main id="app" class="app-main"><h1>${APP_PAGES[name]}</h1></main>
  <script src="/assets/icons.js"></script>
  <script src="/app.js"></script>
  <script src="/${name}.js"></script>`;
  return page(body, { title: APP_PAGES[name], csp: APP_CSP, isPrivate, bodyAttributes: `class="app" data-page="${name}"` });
}

function notFound(isPrivate) {
  return notice({ title: 'Not found', heading: 'There is no Buzz page at this address', paragraphs: [], isPrivate, status: 404 });
}

function attachToSession(ses, { isPrivate }) {
  ses.protocol.handle('buzz', (request) => {
    const url = new URL(request.url);
    const target = url.searchParams.get('url') || '';
    if (url.pathname.startsWith('/assets/')) return serveFile(ASSETS_DIR, url.pathname.slice('/assets/'.length));
    if (/^\/[a-z-]+\.(css|js)$/.test(url.pathname) && url.pathname !== '/preload.js') return serveFile(PAGES_DIR, url.pathname.slice(1));
    if (url.pathname !== '/') return notFound(isPrivate);
    if (Object.hasOwn(APP_PAGES, url.hostname)) return appPage(url.hostname, isPrivate);
    switch (url.hostname) {
      case 'newtab':
        return newTabPage(isPrivate);
      case 'reader':
        return readerPage(ses, target, isPrivate);
      case 'insecure':
        return insecurePage(target, isPrivate);
      case 'error':
        return errorPage(target, url.searchParams.get('reason') || '', isPrivate);
      default:
        return notFound(isPrivate);
    }
  });
}

module.exports = { attachToSession, APP_PAGES, TRUSTED_PAGES };
