// End-to-end self-test, run with `npm run smoke`. Drives the real app against
// a local test server and writes smoke-results.json plus screenshots to
// BUZZ_SMOKE_OUT (or the throwaway profile directory).
const { app, desktopCapturer, session } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { BuzzWindow, MAIN_PARTITION } = require('../src/main/window');
const shields = require('../src/main/shields');
const settings = require('../src/main/settings');
const store = require('../src/main/store');
const downloads = require('../src/main/downloads');
const internal = require('../src/main/internal');
const { fromAddressInput } = require('../src/main/urls');

const OUT = process.env.BUZZ_SMOKE_OUT || app.getPath('userData');
const PARAGRAPH =
  'Honey bees communicate the location of flowers through a waggle dance, and the angle of the dance encodes the direction relative to the sun. ';

const ARTICLE = `<!doctype html><html lang="en"><head><title>The Waggle Dance Explained</title>
<meta property="og:site_name" content="Hive Journal">
<script src="https://www.googletagmanager.com/gtag/js?id=G-SMOKETEST"></script>
<script src="https://www.google-analytics.com/analytics.js"></script>
</head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article><h1>The Waggle Dance Explained</h1><p class="byline">By A. Mellifera</p>
${Array.from({ length: 9 }, (_, i) => `<p>Paragraph ${i + 1}. ${PARAGRAPH.repeat(4)}</p>`).join('\n')}
<img src="/missing.png" onerror="document.documentElement.dataset.handlerRan = '1'">
<script>document.documentElement.dataset.scriptRan = '1';</script>
</article>
<img src="https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1/?smoke=1" width="1" height="1">
<footer>Copyright Hive Journal</footer></body></html>`;

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 10000, label = 'condition') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function test(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? null });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
  }
}

function listen(server, port) {
  return new Promise((resolve) => {
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function go(win, url, expected = (current) => current === url) {
  const tab = win.activeTab;
  win.load(tab, url);
  await waitFor(() => !tab.loading && expected(tab.wc.getURL()), 20000, `load of ${url}`);
  return tab;
}

// Screenshots are an aid for reviewing a run, not a check: capturing fails when
// the window is covered or the display is off, which says nothing about Buzz.
async function screenshot(wc, name) {
  try {
    const image = await wc.capturePage();
    fs.writeFileSync(path.join(OUT, name), image.toPNG());
  } catch {
    // No screenshot this run.
  }
}

// The whole window as the user sees it (UI and page view composited).
async function windowShot(win, name) {
  await sleep(700);
  const [width, height] = win.win.getSize();
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
  const source = sources.find((s) => s.name === win.win.getTitle());
  if (source && !source.thumbnail.isEmpty()) fs.writeFileSync(path.join(OUT, name), source.thumbnail.toPNG());
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const watchdog = setTimeout(() => finish('watchdog: self-test took longer than 240s'), 240000);

  const server = http.createServer((req, res) => {
    if (req.url === '/article') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ARTICLE);
    } else if (req.url === '/cookie' || req.url === '/private-only') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'buzztest=1; Max-Age=3600' });
      res.end('<!doctype html><title>Cookie page</title><p>cookie set</p>');
    } else if (req.url === '/file.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="honey.bin"' });
      res.end(Buffer.alloc(300 * 1024, 7));
    } else {
      res.writeHead(404).end();
    }
  });
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;

  const plain = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Plain HTTP</title><p>plain http ok</p>');
  });
  const port80 = await listen(plain, 80);

  const win = new BuzzWindow();
  let privateWin = null;

  function finish(fatal) {
    clearTimeout(watchdog);
    if (fatal) results.push({ name: 'run', ok: false, detail: fatal });
    const failed = results.filter((r) => !r.ok).length;
    fs.writeFileSync(path.join(OUT, 'smoke-results.json'), JSON.stringify({ failed, results }, null, 2));
    console.log(JSON.stringify({ failed, results }, null, 2));
    app.exit(failed ? 1 : 0);
  }

  const ui = (code) => win.ui.executeJavaScript(code);
  const uiText = (selector) => ui(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const inPage = (tab, code) => tab.wc.executeJavaScript(code);

  await test('address bar input parsing', () => {
    const cases = {
      'example.com': 'https://example.com',
      'example.com/a?b=1': 'https://example.com/a?b=1',
      'http://example.com': 'http://example.com',
      'localhost:3000': 'http://localhost:3000',
      '192.168.1.10/admin': 'http://192.168.1.10/admin',
      'how do bees fly': 'https://duckduckgo.com/?q=how%20do%20bees%20fly',
      'node.js': 'https://node.js',
      bees: 'https://duckduckgo.com/?q=bees',
    };
    for (const [input, want] of Object.entries(cases)) {
      const got = fromAddressInput(input);
      expect(got === want, `"${input}" -> ${got}, wanted ${want}`);
    }
  });

  await test('window UI renders the new tab', async () => {
    await waitFor(async () => (await ui('document.querySelectorAll(".tab").length')) === 1, 15000, 'tab list');
    await waitFor(async () => (await uiText('#shields-state')) === 'Up', 5000, 'shields status');
    expect(win.activeTab.wc.getURL() === 'buzz://newtab/', `new tab URL was ${win.activeTab.wc.getURL()}`);
    expect(win.activeTab.wc.getTitle() === 'New Tab', `new tab title was ${win.activeTab.wc.getTitle()}`);
    await waitFor(() => win.win.isVisible(), 10000, 'window to show');
    const fonts = await ui('document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family))');
    expect(fonts.some((f) => f.includes('Figtree')) && fonts.some((f) => f.includes('Bricolage')), `bundled fonts not loaded: ${fonts}`);
    expect(!(await win.win.isDestroyed()) && fs.existsSync(path.join(__dirname, '../src/assets/icon.png')), 'app icon is missing');
    await waitFor(() => /^#[0-9a-f]{6}$/.test(settings.get('chromeBg')), 5000, 'title-bar colours from the UI');
  });

  await test('filter lists load', async () => {
    await waitFor(() => shields.engineState() !== 'loading', 60000, 'filter lists');
    expect(shields.ready(), `engine state is ${shields.engineState()}`);
  });

  let articleTab = null;
  await test('ads and trackers are blocked and counted', async () => {
    articleTab = await go(win, `${base}/article`);
    // Pixel checks need a visible window; skipped when the display is off or the window is covered.
    const pixel = await articleTab.wc.capturePage({ x: 600, y: 5, width: 1, height: 1 }).then((image) => image.toBitmap(), () => null);
    if (pixel && pixel.length >= 3) expect(pixel[0] > 240 && pixel[1] > 240 && pixel[2] > 240, `a site with no background of its own is not white: ${[...pixel]}`);
    await waitFor(() => shields.blockedOn(articleTab.wc.id) >= 3, 8000, '3 blocked requests');
    const blocked = shields.blockedOn(articleTab.wc.id);
    await waitFor(async () => (await uiText('.shields-figure .count')) === String(blocked), 3000, 'UI blocked count');
    expect((await uiText('#site-switch-label')) === 'Protect 127.0.0.1', 'shields panel shows the wrong host');
    return `${blocked} requests blocked`;
  });

  await test('per-site shields toggle stops blocking', async () => {
    win.handleAction('toggle-site-shields');
    await sleep(300);
    await waitFor(() => !articleTab.loading, 20000, 'reload with shields down');
    await sleep(1500);
    const blocked = shields.blockedOn(articleTab.wc.id);
    const status = await uiText('#shields-state');
    win.handleAction('toggle-site-shields');
    await sleep(300);
    await waitFor(() => !articleTab.loading, 20000, 'reload with shields up');
    expect(blocked === 0, `${blocked} requests were still blocked with shields down`);
    expect(status === 'Down', `status read "${status}"`);
    await waitFor(() => shields.blockedOn(articleTab.wc.id) >= 3, 8000, 'blocking to resume');
  });

  await test('web pages cannot navigate to buzz:// pages or call Buzz APIs', async () => {
    expect((await inPage(articleTab, 'typeof window.buzz')) === 'undefined', 'a website can see the internal API');
    await inPage(articleTab, 'location.href = "buzz://settings/"; 0');
    await sleep(800);
    expect(articleTab.wc.getURL() === `${base}/article`, `page reached ${articleTab.wc.getURL()}`);
  });

  await test('history records visits with titles', async () => {
    await waitFor(() => store.queryVisits({ text: 'waggle' }).some((v) => v.title === 'The Waggle Dance Explained'), 5000, 'visit in history');
    const visits = store.queryVisits({ text: '/article' });
    expect(visits.length === 1, `expected one visit despite reloads, found ${visits.length}`);
  });

  await test('address bar suggests history and searches over a frozen page', async () => {
    const local = await win.suggest('waggle');
    expect(local[0].type === 'search' && local[0].text === 'waggle', 'first row is not the typed search');
    expect(local.some((s) => s.type === 'history' && s.url === `${base}/article`), 'history match missing');
    const remote = (await win.suggest('honey b')).filter((s) => s.type === 'search');
    expect(remote.length >= 3, `expected search-engine suggestions, got ${remote.length}`);

    win.ui.focus();
    await ui('{ const a = document.getElementById("address"); a.focus(); a.value = "waggle"; a.dispatchEvent(new Event("input")); } 0');
    await waitFor(async () => (await ui('!document.getElementById("suggest").hidden && document.querySelectorAll(".suggestion").length')) >= 2, 6000, 'suggestion list');
    // The live page is swapped out for a snapshot (or a plain backdrop when no snapshot can be taken).
    await waitFor(() => !articleTab.view.getVisible(), 5000, 'page view to step aside for the list');
    const box = await ui('JSON.stringify([document.getElementById("suggest").getBoundingClientRect(), document.getElementById("address-form").getBoundingClientRect()].map((r) => [Math.round(r.left), Math.round(r.width)]))');
    const [[listLeft, listWidth], [barLeft, barWidth]] = JSON.parse(box);
    expect(listLeft === barLeft && listWidth === barWidth, `list ${listLeft}/${listWidth} is not aligned to the address bar ${barLeft}/${barWidth}`);
    await windowShot(win, 'window-suggestions.png');
    await ui('document.getElementById("address").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); 0');
    await waitFor(async () => (await ui('document.getElementById("suggest").hidden')) && articleTab.view.getVisible(), 3000, 'list to close and page to return');
    await ui('document.getElementById("address").blur(); 0');
    return `${remote.length} engine suggestions`;
  });

  await test('reader mode shows the article and runs no page scripts', async () => {
    await waitFor(() => articleTab.readerable, 5000, 'page to be detected as an article');
    win.handleAction('toggle-reader');
    await waitFor(() => !articleTab.loading && articleTab.wc.getURL().startsWith('buzz://reader/'), 10000, 'reader view');
    await sleep(600);
    const page = await inPage(
      articleTab,
      '({ title: document.title, text: document.body.innerText, scripts: document.scripts.length, nav: !!document.querySelector("nav"), h1: document.querySelector("h1").textContent, ran: { ...document.documentElement.dataset }, images: document.querySelectorAll(".article img").length, font: getComputedStyle(document.querySelector(".reader")).fontFamily, api: typeof window.buzz })',
    );
    expect(page.images === 1, `expected the article image to be kept, found ${page.images}`);
    expect(!page.ran.handlerRan && !page.ran.scriptRan, `page code ran in reader view: ${JSON.stringify(page.ran)}`);
    expect(page.api === 'undefined', 'reader view can see the internal API');
    expect(page.font.includes('Literata'), `reader font was ${page.font}`);
    expect(page.title === 'The Waggle Dance Explained', `title was "${page.title}"`);
    expect(page.h1 === 'The Waggle Dance Explained', `heading was "${page.h1}"`);
    expect(page.text.includes('Paragraph 9.'), 'article body is missing');
    expect(!page.nav && !page.text.includes('Copyright Hive Journal'), 'page clutter was kept');
    expect((await ui('document.getElementById("reader").getAttribute("aria-pressed")')) === 'true', 'reader button is not shown as active');
    expect((await ui('document.getElementById("address").value')) === `${base}/article`, 'address bar does not show the article URL');
    await windowShot(win, 'window-reader.png');
    win.handleAction('toggle-reader');
    await waitFor(() => !articleTab.loading && articleTab.wc.getURL() === `${base}/article`, 10000, 'return to the page');
    return `${page.scripts} script elements in reader view`;
  });

  await test('HTTP is upgraded to HTTPS', async () => {
    const tab = await go(win, 'http://example.com/', (url) => url.startsWith('https://example.com'));
    const kind = await ui('document.getElementById("security").className');
    expect(kind.includes('secure') && !kind.includes('insecure'), `security indicator was "${kind}"`);
    return tab.wc.getURL();
  });

  await test('sites without HTTPS show a warning, then load on request', async () => {
    if (!port80) return 'SKIPPED: port 80 is in use on this machine';
    const tab = await go(win, 'http://insecure.test/', (url) => url.startsWith('buzz://insecure/'));
    expect((await inPage(tab, 'document.body.innerText')).includes('insecure.test'), 'warning does not name the site');
    await screenshot(tab.wc, 'page-insecure.png');
    await inPage(tab, 'document.querySelector("a.button").click(); 0');
    await waitFor(() => !tab.loading && tab.wc.getURL() === 'http://insecure.test/', 10000, 'HTTP site after continuing');
    expect((await inPage(tab, 'document.body.innerText')).includes('plain http ok'), 'HTTP page did not load');
    await sleep(200);
    const kind = await ui('document.getElementById("security").className');
    expect(kind.includes('insecure'), `security indicator was "${kind}"`);
  });

  await test('unreachable sites show an error page', async () => {
    const tab = await go(win, 'https://127.0.0.1:9/', (url) => url.startsWith('buzz://error/'));
    expect((await inPage(tab, 'document.body.innerText')).includes('could not be loaded'), 'error page text missing');
  });

  await test('tabs open, switch and close', async () => {
    win.handleAction('new-tab');
    win.createTab(`${base}/cookie`, { active: false });
    await waitFor(async () => (await ui('document.querySelectorAll(".tab").length')) === 3, 5000, '3 tabs in the sidebar');
    const last = win.tabs[2];
    win.handleAction('activate-tab', last.id);
    await waitFor(() => !last.loading && last.wc.getTitle() === 'Cookie page', 10000, 'background tab load');
    await waitFor(async () => (await uiText('.tab.active .tab-title')) === 'Cookie page', 3000, 'active tab title');
    win.handleAction('close-tab', last.id);
    win.handleAction('close-tab', win.tabs[1].id);
    await waitFor(async () => (await ui('document.querySelectorAll(".tab").length')) === 1, 5000, 'tabs to close');
    expect(win.activeTab === win.tabs[0], 'wrong tab active after closing');
  });

  await test('sleeping a background tab frees its process and it wakes with its history', async () => {
    const first = win.activeTab;
    const tab = win.createTab(`${base}/cookie`);
    await waitFor(() => !tab.loading && tab.wc.getURL() === `${base}/cookie`, 10000, 'first page');
    await go(win, `${base}/article`);
    win.activate(first);
    await sleep(500);
    const before = internal.memoryStats();
    expect(win.sleepTab(tab), 'tab refused to sleep');
    expect(tab.asleep && tab.wc === null, 'tab still has a page after sleeping');
    await waitFor(async () => (await ui('document.querySelectorAll(".tab.asleep").length')) === 1, 3000, 'sleeping tab in the sidebar');
    await sleep(1500);
    const after = internal.memoryStats();
    expect(after.asleep === 1, `stats report ${after.asleep} sleeping tabs`);
    expect(!win.sleepTab(first), 'the active tab was put to sleep');

    win.activate(tab);
    await waitFor(() => tab.wc && !tab.loading && tab.wc.getURL() === `${base}/article`, 10000, 'tab to wake on its last page');
    expect(tab.wc.navigationHistory.canGoBack(), 'back history was lost while asleep');
    expect(store.queryVisits({ text: '/article' }).length === 2, 'waking a tab added a duplicate history entry');
    win.closeTab(tab);
    const byType = {};
    for (const m of app.getAppMetrics()) byType[m.type] = (byType[m.type] || 0) + Math.round((m.memory.privateBytes ?? m.memory.workingSetSize) / 1024);
    return `${before.megabytes} MB in ${before.processes} processes before, ${after.megabytes} MB in ${after.processes} after; now ${JSON.stringify(byType)}`;
  });

  await test('idle tabs sleep on their own when memory saver is on', async () => {
    const tab = win.createTab(`${base}/cookie`, { active: false });
    await waitFor(() => !tab.loading && tab.wc.getURL() === `${base}/cookie`, 10000, 'background page');
    expect(win.sleepIdleTabs() === 0, 'a fresh tab was put to sleep');
    const later = Date.now() + (settings.get('sleepAfterMin') + 1) * 60000;
    settings.set('memorySaver', false);
    expect(win.sleepIdleTabs(later) === 0, 'tabs slept with memory saver off');
    settings.set('memorySaver', true);
    expect(win.sleepIdleTabs(later) === 1 && tab.asleep, 'idle tab did not sleep');
    win.closeTab(tab);
  });

  await test('sidebar collapses and the page resizes', async () => {
    const before = win.activeTab.view.getBounds();
    win.handleAction('toggle-sidebar');
    await waitFor(async () => await ui('document.body.classList.contains("collapsed")'), 3000, 'collapsed sidebar');
    const collapsed = win.activeTab.view.getBounds();
    const sidebarWidth = await ui('document.getElementById("sidebar").getBoundingClientRect().width');
    await windowShot(win, 'window-collapsed.png');
    win.handleAction('toggle-sidebar');
    await waitFor(async () => !(await ui('document.body.classList.contains("collapsed")')), 3000, 'expanded sidebar');
    const expandedWidth = await ui('document.getElementById("sidebar").getBoundingClientRect().width');
    const toolbarHeight = await ui('document.getElementById("toolbar").getBoundingClientRect().height');
    expect(collapsed.x === sidebarWidth, `page starts at ${collapsed.x} but the collapsed sidebar is ${sidebarWidth} wide`);
    expect(before.x === expandedWidth, `page starts at ${before.x} but the sidebar is ${expandedWidth} wide`);
    expect(before.y === toolbarHeight, `page starts at y=${before.y} but the toolbar is ${toolbarHeight} tall`);
    const gap = await ui('(() => { const t = document.getElementById("toolbar-shields").getBoundingClientRect(); return innerWidth - t.right; })()');
    expect(gap >= 120, `toolbar leaves only ${gap}px for the window buttons`);
  });

  await test('downloads save to the chosen folder and appear on the downloads page', async () => {
    const dir = path.join(OUT, 'downloads');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    settings.set('downloadDir', dir);
    win.activeTab.wc.downloadURL(`${base}/file.bin`);
    win.activeTab.wc.downloadURL(`${base}/file.bin`);
    const list = () => downloads.list(win.session, false);
    await waitFor(() => list().length === 2 && list().every((d) => d.state === 'completed'), 15000, 'both downloads to finish');
    const names = list().map((d) => d.filename).sort();
    expect(names[0] === 'honey (1).bin' && names[1] === 'honey.bin', `saved as ${names}`);
    expect(fs.statSync(path.join(dir, 'honey.bin')).size === 300 * 1024, 'downloaded file has the wrong size');

    win.openInternal('downloads');
    const tab = win.activeTab;
    await waitFor(async () => !tab.loading && (await inPage(tab, 'document.querySelectorAll(".item").length')) === 2, 8000, 'downloads page rows');
    expect((await inPage(tab, 'document.querySelector(".item-sub").textContent')).includes('300 KB'), 'size missing from the downloads page');
    await windowShot(win, 'window-downloads.png');
    await inPage(tab, 'document.querySelector(".item [title=\\"Remove from list\\"]").click(); 0');
    await waitFor(() => list().length === 1, 3000, 'row removal');
    expect(fs.existsSync(path.join(dir, 'honey.bin')) && fs.existsSync(path.join(dir, 'honey (1).bin')), 'removing a row deleted the file');
    expect(store.listDownloads().length === 1, 'downloads list was not saved to disk');
  });

  await test('history page lists, searches and removes visits', async () => {
    win.openInternal('history');
    const tab = win.activeTab;
    await waitFor(async () => !tab.loading && (await inPage(tab, 'document.querySelectorAll(".item").length')) >= 3, 8000, 'history rows');
    expect((await inPage(tab, 'document.querySelector(".day").textContent')) === 'Today', 'day heading missing');
    await windowShot(win, 'window-history.png');
    await inPage(tab, '{ const s = document.querySelector("input[type=search]"); s.value = "waggle"; s.dispatchEvent(new Event("input")); } 0');
    await waitFor(async () => (await inPage(tab, '[...document.querySelectorAll(".item-title")].every((a) => a.textContent.includes("Waggle")) && document.querySelectorAll(".item").length')) === 2, 5000, 'filtered rows');
    await inPage(tab, 'document.querySelector(".item .tool").click(); 0');
    await waitFor(() => store.queryVisits({ text: 'waggle' }).length === 1, 3000, 'visit removal');
  });

  await test('settings change the look, the search engine and the interface size', async () => {
    win.openInternal('settings');
    const tab = win.activeTab;
    await waitFor(async () => !tab.loading && (await inPage(tab, 'document.querySelectorAll(".section").length')) === 6, 8000, 'settings sections');
    await sleep(400);
    await windowShot(win, 'window-settings.png');

    const colorBefore = settings.get('chromeBg');
    await inPage(tab, 'document.querySelector(".swatch[data-value=lagoon]").click(); 0');
    await waitFor(async () => (await ui('document.documentElement.dataset.scheme')) === 'lagoon', 3000, 'scheme in the browser UI');
    await waitFor(async () => (await inPage(tab, 'document.documentElement.dataset.scheme')) === 'lagoon', 3000, 'scheme on the settings page');
    await waitFor(() => settings.get('chromeBg') !== colorBefore, 3000, 'title-bar colour to follow the scheme');

    const themeButton = (label) => `[...document.querySelectorAll(".segmented button")].find((b) => b.textContent === "${label}").click(); 0`;
    await inPage(tab, themeButton('Light'));
    await waitFor(async () => (await ui('matchMedia("(prefers-color-scheme: light)").matches')) === true, 3000, 'light theme');
    await sleep(500);
    await windowShot(win, 'window-settings-light.png');
    const lightBg = settings.get('chromeBg');
    await inPage(tab, themeButton('Dark'));
    await waitFor(async () => (await ui('matchMedia("(prefers-color-scheme: dark)").matches')) === true, 3000, 'dark theme');
    await waitFor(() => settings.get('chromeBg') !== lightBg, 3000, 'title-bar colour to follow the theme');

    await inPage(tab, themeButton('Mono'));
    await waitFor(async () => (await ui('getComputedStyle(document.body).fontFamily')).includes('JetBrains Mono'), 3000, 'interface font');
    await inPage(tab, themeButton('Figtree'));

    await inPage(tab, '{ const s = document.querySelector("select[aria-label=\\"Search engine\\"]"); s.value = "brave"; s.dispatchEvent(new Event("change")); } 0');
    await waitFor(() => settings.get('searchEngine') === 'brave', 3000, 'search engine setting');
    expect(fromAddressInput('bees') === 'https://search.brave.com/search?q=bees', `search went to ${fromAddressInput('bees')}`);
    await waitFor(async () => (await ui('document.getElementById("address").placeholder')).includes('Brave Search'), 3000, 'engine name in the address bar');
    expect((await win.suggest('honey b')).filter((s) => s.type === 'search').length >= 3, 'no suggestions from the new engine');

    await inPage(tab, themeButton('Larger'));
    await waitFor(() => Math.abs(win.ui.getZoomFactor() - 1.25) < 0.001, 3000, 'interface zoom');
    await sleep(400);
    const sidebar = await ui('document.getElementById("sidebar").getBoundingClientRect().width * 1.25');
    expect(Math.abs(tab.view.getBounds().x - sidebar) <= 1, `page starts at ${tab.view.getBounds().x} but the scaled sidebar ends at ${sidebar}`);
    await inPage(tab, themeButton('Default'));
    await waitFor(() => Math.abs(win.ui.getZoomFactor() - 1) < 0.001, 3000, 'interface zoom reset');

    // The readout pauses while its page is hidden (window covered, display off),
    // so check the number behind it directly and the on-page text only when visible.
    const stats = internal.memoryStats();
    expect(stats.megabytes > 50 && stats.processes >= 3, `memory stats were ${JSON.stringify(stats)}`);
    const memory = (await inPage(tab, 'document.hidden')) ? 'page hidden, readout paused' : await inPage(tab, 'document.querySelector(".figure").textContent');
    expect(memory.startsWith('page hidden') || /^[\d,.\s]+ MB$/.test(memory) || memory === '…', `memory readout was "${memory}"`);
    expect(!settings.setFromUser('shieldsOffHosts', []) && !settings.setFromUser('theme', 'neon'), 'settings accepted an invalid change');
    return `memory readout ${memory}`;
  });

  await test('new tab page shows most-visited sites and the chosen engine', async () => {
    win.handleAction('new-tab');
    const tab = win.activeTab;
    await waitFor(() => !tab.loading && tab.wc.getURL() === 'buzz://newtab/', 8000, 'new tab');
    const page = await inPage(tab, '({ sites: [...document.querySelectorAll(".site-name")].map((s) => s.textContent), placeholder: document.querySelector(".search input").placeholder, action: document.querySelector(".search").action, scheme: document.documentElement.dataset.scheme })');
    expect(page.sites.includes('127.0.0.1'), `most visited was ${page.sites}`);
    expect((await ui('document.querySelector(".tab.active .tab-icon img").getAttribute("src")')).endsWith('logo.svg'), 'Buzz pages have no tab icon');
    expect(page.placeholder === 'Search with Brave Search' && page.action === 'https://search.brave.com/search', `search form was ${page.placeholder} -> ${page.action}`);
    expect(page.scheme === 'lagoon', 'new tab page ignores the colour scheme');
    await windowShot(win, 'window-newtab-lagoon.png');
    settings.set('scheme', 'honey');
    settings.set('theme', 'system');
    await waitFor(async () => !tab.loading && (await inPage(tab, 'document.documentElement.dataset.scheme')) === 'honey', 5000, 'new tab to pick up the scheme');
    await windowShot(win, 'window-newtab.png');
    await go(win, `${base}/article`);
    await windowShot(win, 'window-article.png');
  });

  await test('private windows keep their data separate and wipe it on close', async () => {
    privateWin = new BuzzWindow({ isPrivate: true, url: `${base}/private-only` });
    const tab = privateWin.activeTab;
    const privateSession = privateWin.session;
    const mainSession = session.fromPartition(MAIN_PARTITION);
    await waitFor(() => !tab.loading && tab.wc.getURL() === `${base}/private-only`, 15000, 'private window load');
    await waitFor(async () => (await privateSession.cookies.get({ name: 'buzztest' })).length === 1, 3000, 'cookie in the private session');
    expect(!privateSession.isPersistent(), 'private session is persistent');
    expect(mainSession.isPersistent(), 'main session is not persistent');
    // The main window visited /cookie earlier, so clear that copy to prove isolation.
    await mainSession.cookies.remove(base, 'buzztest');
    privateWin.load(tab, `${base}/private-only`);
    await sleep(300);
    await waitFor(() => !tab.loading, 10000, 'private reload');
    expect((await mainSession.cookies.get({ name: 'buzztest' })).length === 0, 'private cookie leaked into the main session');
    expect(store.queryVisits({ text: 'private-only' }).length === 0, 'a private visit was written to history');
    expect((await privateWin.suggest('waggle')).every((s) => s.type !== 'history'), 'private window suggested history');
    await waitFor(async () => await privateWin.ui.executeJavaScript('document.documentElement.classList.contains("private")'), 5000, 'private theme');
    privateWin.handleAction('new-tab');
    await waitFor(() => !privateWin.activeTab.loading && privateWin.activeTab.wc.getURL() === 'buzz://newtab/', 8000, 'private new tab');
    await windowShot(privateWin, 'window-private.png');
    privateWin.win.close();
    await waitFor(async () => (await privateSession.cookies.get({ name: 'buzztest' })).length === 0, 5000, 'private cookies to be wiped');
  });

  server.close();
  plain.close();
  finish();
}

module.exports = { run };
