// A Buzz window: the chrome UI (sidebar with vertical tabs, toolbar) plus one
// WebContentsView per awake tab, laid out next to the sidebar.
const { BrowserWindow, WebContentsView, Menu, clipboard, dialog, nativeImage, nativeTheme, session } = require('electron');
const path = require('node:path');
const settings = require('./settings');
const shields = require('./shields');
const pages = require('./pages');
const reader = require('./reader');
const search = require('./search');
const store = require('./store');
const downloads = require('./downloads');
const { NEW_TAB_URL, hostOf, isWebUrl, isInternalUrl, internalPage, typedUrl, fromAddressInput, describeUrl } = require('./urls');

// Keep in sync with the layout variables in src/ui/ui.css (CSS px at 100% interface size).
const SIDEBAR_WIDTH = 264;
const SIDEBAR_COLLAPSED_WIDTH = 56;
const TOOLBAR_HEIGHT = 48;

const MAIN_PARTITION = 'persist:buzz';
const ICON = nativeImage.createFromPath(path.join(__dirname, '../assets/icon.png'));
const MAX_FAVICON_BYTES = 64 * 1024;
const MAX_SUGGESTIONS = 9;
const ERR_ABORTED = -3;
// Failures that say nothing about HTTPS support (DNS, offline), so no HTTP fallback is offered.
const NOT_TLS_FAILURES = new Set([-105, -106, -137]);

const AUTO_ALLOWED_PERMISSIONS = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);
const PERMISSION_PROMPTS = {
  media: 'use your camera and microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
};

const windows = new Set();
const configuredSessions = new WeakSet();
let nextTabId = 1;
let nextPrivateId = 1;

// Title-bar colours until the UI reports the real ones for the current theme.
function chromeColors(isPrivate) {
  if (isPrivate) return { bg: '#1b1524', symbol: '#efe9f7' };
  if (settings.get('chromeBg') && settings.get('chromeSymbol')) return { bg: settings.get('chromeBg'), symbol: settings.get('chromeSymbol') };
  return nativeTheme.shouldUseDarkColors ? { bg: '#1a1712', symbol: '#f3ecdc' } : { bg: '#f3ecdc', symbol: '#1d1a14' };
}

function setupSession(ses, { isPrivate }) {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);
  pages.attachToSession(ses, { isPrivate });
  shields.attachToSession(ses);
  downloads.attachToSession(ses, { isPrivate });
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (AUTO_ALLOWED_PERMISSIONS.has(permission)) return callback(true);
    const what = PERMISSION_PROMPTS[permission];
    const owner = wc && BuzzWindow.forWebContents(wc);
    const host = hostOf(details.requestingUrl || (wc ? wc.getURL() : ''));
    if (!what || !owner || !host) return callback(false);
    dialog
      .showMessageBox(owner.win, {
        type: 'question',
        buttons: ['Allow', 'Block'],
        defaultId: 1,
        cancelId: 1,
        message: `Allow ${host} to ${what}?`,
      })
      .then(({ response }) => callback(response === 0))
      .catch(() => callback(false));
  });
}

class BuzzWindow {
  static all() {
    return [...windows];
  }

  static forUi(wc) {
    return BuzzWindow.all().find((w) => w.ui === wc) || null;
  }

  static forWebContents(wc) {
    return BuzzWindow.all().find((w) => w.ui === wc || w.tabs.some((t) => t.wc === wc)) || null;
  }

  static forSession(ses) {
    return BuzzWindow.all().filter((w) => w.session === ses);
  }

  constructor({ isPrivate = false, url = NEW_TAB_URL } = {}) {
    this.isPrivate = isPrivate;
    this.session = isPrivate ? session.fromPartition(`private-${nextPrivateId++}`) : session.fromPartition(MAIN_PARTITION);
    setupSession(this.session, { isPrivate });

    this.tabs = [];
    this.activeTab = null;
    this.closed = false;
    this.htmlFullScreen = false;
    this.fullScreenByPage = false;
    this.overlayOpen = false;
    this.stateTimer = null;

    const colors = chromeColors(isPrivate);
    this.win = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 760,
      minHeight: 440,
      show: false,
      title: 'Buzz',
      icon: ICON,
      backgroundColor: colors.bg,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: colors.bg, symbolColor: colors.symbol, height: this.scaled(TOOLBAR_HEIGHT) - 1 },
      webPreferences: {
        preload: path.join(__dirname, '../ui/preload.js'),
        sandbox: true,
        contextIsolation: true,
      },
    });
    this.ui = this.win.webContents;
    windows.add(this);

    this.ui.on('will-navigate', (e) => e.preventDefault());
    this.ui.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.ui.on('before-input-event', (e, input) => this.handleShortcut(e, input));
    this.ui.on('did-finish-load', () => {
      this.ui.setZoomFactor(settings.get('uiScale'));
      this.sendState();
    });
    this.win.loadFile(path.join(__dirname, '../ui/index.html'), { query: isPrivate ? { private: '1' } : {} });

    this.win.once('ready-to-show', () => this.win.show());
    this.win.on('resize', () => this.layout());
    this.win.on('closed', () => this.dispose());

    this.onExternalChange = () => {
      if (this.closed) return;
      if (Math.abs(this.ui.getZoomFactor() - settings.get('uiScale')) > 0.001) {
        this.ui.setZoomFactor(settings.get('uiScale'));
        this.applyTitleBar();
      }
      this.layout();
      this.sendState();
    };
    shields.events.on('change', this.onExternalChange);
    downloads.events.on('change', this.onExternalChange);

    this.createTab(url);
  }

  dispose() {
    this.closed = true;
    windows.delete(this);
    clearTimeout(this.stateTimer);
    shields.events.off('change', this.onExternalChange);
    downloads.events.off('change', this.onExternalChange);
    for (const tab of this.tabs) this.destroyView(tab);
    this.tabs = [];
    this.activeTab = null;
    if (this.isPrivate) {
      // The partition is in-memory only; wipe it now rather than at process exit.
      downloads.forgetSession(this.session);
      this.session.clearStorageData().catch(() => {});
      this.session.clearCache().catch(() => {});
    }
  }

  scaled(px) {
    return Math.round(px * settings.get('uiScale'));
  }

  applyTitleBar(colors = this.titleBarColors || chromeColors(this.isPrivate)) {
    if (this.closed) return;
    this.titleBarColors = colors;
    this.win.setBackgroundColor(colors.bg);
    this.win.setTitleBarOverlay({ color: colors.bg, symbolColor: colors.symbol, height: this.scaled(TOOLBAR_HEIGHT) - 1 });
  }

  // ---------------------------------------------------------------- tabs

  createTab(url = NEW_TAB_URL, { active = true, opener = null } = {}) {
    const tab = {
      id: nextTabId++,
      view: null,
      wc: null,
      url,
      title: 'New Tab',
      favicon: null,
      faviconUrl: null,
      loading: false,
      audible: false,
      readerable: false,
      asleep: false,
      saved: null, // navigation history kept while the tab sleeps
      lastActive: Date.now(),
      visitId: 0,
      visitUrl: '',
    };
    const openerIndex = opener ? this.tabs.indexOf(opener) : -1;
    if (openerIndex >= 0) this.tabs.splice(openerIndex + 1, 0, tab);
    else this.tabs.push(tab);

    this.attachView(tab);
    this.load(tab, url);
    if (active) this.activate(tab);
    else this.sendState();
    return tab;
  }

  attachView(tab) {
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        preload: path.join(__dirname, '../pages/preload.js'),
        sandbox: true,
        contextIsolation: true,
      },
    });
    tab.view = view;
    tab.wc = view.webContents;
    this.paintBackground(tab, tab.url);
    this.wireTab(tab);
  }

  // What shows behind a page that sets no background of its own: white for
  // websites (the web's default), the theme colour for Buzz's own pages.
  paintBackground(tab, url) {
    const themed = (this.titleBarColors || chromeColors(this.isPrivate)).bg;
    tab.view.setBackgroundColor(isInternalUrl(url) ? themed : '#ffffff');
  }

  destroyView(tab) {
    if (!tab.view) return;
    const wc = tab.wc;
    shields.forgetTab(wc.id);
    tab.view = null;
    tab.wc = null;
    if (!wc.isDestroyed()) wc.close();
  }

  newTab() {
    this.createTab(NEW_TAB_URL);
    this.focusAddress();
  }

  // Open (or switch to) one of the buzz:// app pages.
  openInternal(name) {
    const existing = this.tabs.find((t) => internalPage(t.wc ? t.wc.getURL() : t.url) === name);
    if (existing) this.activate(existing);
    else this.createTab(`buzz://${name}/`);
  }

  load(tab, url) {
    tab.url = url;
    // Failures surface through 'did-fail-load'; the promise rejection is redundant.
    tab.wc.loadURL(url).catch(() => {});
  }

  wireTab(tab) {
    const wc = tab.wc;
    const update = () => this.sendState();
    // Events can still arrive while a tab's page is being torn down (sleep, close).
    const on = (event, handler) =>
      wc.on(event, (...args) => {
        if (tab.wc === wc && !this.closed) handler(...args);
      });

    on('did-start-loading', () => {
      tab.loading = true;
      update();
    });
    on('did-stop-loading', () => {
      tab.loading = false;
      update();
      this.checkReaderable(tab);
    });
    on('page-title-updated', (_e, title) => {
      tab.title = title;
      if (tab.visitId && tab.visitUrl === wc.getURL()) store.setVisitTitle(tab.visitId, title);
      update();
    });
    on('page-favicon-updated', (_e, icons) => this.loadFavicon(tab, icons[0]));
    on('audio-state-changed', (e) => {
      tab.audible = e.audible;
      update();
    });
    on('did-navigate', (_e, url) => {
      shields.resetTab(wc.id);
      this.paintBackground(tab, url);
      tab.url = url;
      tab.favicon = null;
      tab.faviconUrl = null;
      tab.readerable = false;
      this.recordVisit(tab, url);
      if (tab === this.activeTab) this.closeOverlay();
      update();
    });
    on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      this.recordVisit(tab, url);
      update();
    });
    on('did-fail-load', (_e, code, description, validatedURL, isMainFrame) => {
      if (isMainFrame && code !== ERR_ABORTED) this.showLoadFailure(tab, validatedURL, description, code);
    });
    on('will-navigate', (e, url) => this.guardNavigation(tab, e, url));
    on('will-redirect', (e, url) => {
      if (isInternalUrl(url)) e.preventDefault();
    });
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (isWebUrl(url)) this.createTab(url, { active: disposition !== 'background-tab', opener: tab });
      return { action: 'deny' };
    });
    on('context-menu', (_e, params) => this.showContextMenu(tab, params));
    on('before-input-event', (e, input) => this.handleShortcut(e, input));
    on('found-in-page', (_e, result) => {
      if (tab === this.activeTab) this.sendToUi('find-result', { active: result.activeMatchOrdinal, total: result.matches });
    });
    on('enter-html-full-screen', () => {
      this.htmlFullScreen = true;
      if (!this.win.isFullScreen()) {
        this.fullScreenByPage = true;
        this.win.setFullScreen(true);
      }
      this.layout();
    });
    on('leave-html-full-screen', () => {
      this.htmlFullScreen = false;
      if (this.fullScreenByPage) {
        this.fullScreenByPage = false;
        this.win.setFullScreen(false);
      }
      this.layout();
    });
  }

  // History: one entry per page visited (not per reload, not per #fragment), never in private windows.
  recordVisit(tab, url) {
    if (this.isPrivate || !isWebUrl(url)) return;
    const page = url.split('#')[0];
    if (page === tab.visitUrl.split('#')[0]) return;
    tab.visitUrl = url;
    tab.visitId = store.addVisit(url, '');
  }

  // Pages may not navigate to buzz:// URLs, except Buzz's own pages linking to
  // each other and the "continue" link on the HTTPS warning.
  guardNavigation(tab, event, url) {
    if (!isInternalUrl(url)) return;
    const current = tab.wc.getURL();
    if (pages.TRUSTED_PAGES.has(internalPage(current)) && !url.startsWith('buzz://insecure/')) return;
    event.preventDefault();
    if (!current.startsWith('buzz://insecure/') || !url.startsWith('buzz://insecure/proceed?')) return;
    try {
      const target = new URL(url).searchParams.get('url') || '';
      if (isWebUrl(target) && target === new URL(current).searchParams.get('url')) {
        shields.allowInsecure(new URL(target).hostname);
        this.load(tab, target);
      }
    } catch {
      // Malformed URL: stay on the warning.
    }
  }

  showLoadFailure(tab, failedUrl, description, code) {
    if (isInternalUrl(failedUrl)) return;
    const httpUrl = NOT_TLS_FAILURES.has(code) ? null : shields.upgradeFallback(tab.wc.id, failedUrl);
    if (httpUrl) {
      this.load(tab, 'buzz://insecure/?url=' + encodeURIComponent(httpUrl));
      return;
    }
    const reason = `${description || 'Load failed'} (${code})`;
    this.load(tab, 'buzz://error/?url=' + encodeURIComponent(failedUrl) + '&reason=' + encodeURIComponent(reason));
  }

  async loadFavicon(tab, iconUrl) {
    if (!isWebUrl(iconUrl)) return;
    tab.faviconUrl = iconUrl;
    try {
      // Fetched through the tab's own session, so private windows stay isolated.
      const res = await this.session.fetch(iconUrl);
      const type = (res.headers.get('content-type') || 'image/x-icon').split(';')[0].trim();
      if (!res.ok || !type.startsWith('image/')) return;
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > MAX_FAVICON_BYTES || tab.faviconUrl !== iconUrl) return;
      tab.favicon = `data:${type};base64,${data.toString('base64')}`;
      this.sendState();
    } catch {
      // No favicon; the UI shows a placeholder.
    }
  }

  async checkReaderable(tab) {
    const wc = tab.wc;
    const url = wc.getURL();
    if (!isWebUrl(url)) return;
    const readerable = await reader.isReaderable(wc);
    if (tab.wc !== wc || wc.isDestroyed() || wc.getURL() !== url || tab.readerable === readerable) return;
    tab.readerable = readerable;
    this.sendState();
  }

  activate(tab) {
    if (!tab || this.activeTab === tab) return;
    this.closeOverlay();
    if (this.activeTab) {
      this.activeTab.lastActive = Date.now();
      this.activeTab.wc.stopFindInPage('clearSelection');
      this.win.contentView.removeChildView(this.activeTab.view);
    }
    if (tab.asleep) this.wakeTab(tab);
    this.activeTab = tab;
    this.win.contentView.addChildView(tab.view);
    this.layout();
    tab.wc.focus();
    this.sendToUi('close-find');
    this.sendState();
  }

  closeTab(tab) {
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    if (this.tabs.length === 1) {
      this.win.close();
      return;
    }
    this.tabs.splice(index, 1);
    if (this.activeTab === tab) {
      this.win.contentView.removeChildView(tab.view);
      this.activeTab = null;
      this.activate(this.tabs[Math.min(index, this.tabs.length - 1)]);
    }
    this.destroyView(tab);
    this.sendState();
  }

  cycleTab(step) {
    const index = this.tabs.indexOf(this.activeTab);
    this.activate(this.tabs[(index + step + this.tabs.length) % this.tabs.length]);
  }

  tabById(id) {
    return this.tabs.find((t) => t.id === id) || null;
  }

  // -------------------------------------------------------- memory saver

  // Free a background tab's page and process; it is rebuilt when the tab is opened again.
  sleepTab(tab) {
    if (!tab.view || tab === this.activeTab || tab.audible) return false;
    const url = tab.wc.getURL();
    if (!url) return false;
    const history = tab.wc.navigationHistory;
    tab.saved = { entries: history.getAllEntries(), index: history.getActiveIndex() };
    tab.url = url;
    tab.loading = false;
    tab.asleep = true;
    this.destroyView(tab);
    this.sendState();
    return true;
  }

  wakeTab(tab) {
    if (!tab.asleep) return;
    const { saved, url } = tab;
    tab.asleep = false;
    tab.saved = null;
    this.attachView(tab);
    const restore = saved && saved.entries.length ? tab.wc.navigationHistory.restore(saved) : Promise.reject(new Error('nothing saved'));
    restore.catch(() => {
      if (tab.wc && !tab.wc.isDestroyed()) this.load(tab, url);
    });
  }

  sleepIdleTabs(now = Date.now()) {
    if (this.closed || !settings.get('memorySaver')) return 0;
    const idleMs = settings.get('sleepAfterMin') * 60 * 1000;
    return this.tabs.filter((tab) => now - tab.lastActive >= idleMs && this.sleepTab(tab)).length;
  }

  // -------------------------------------------------------------- layout

  layout() {
    if (this.closed || !this.activeTab) return;
    const [width, height] = this.win.getContentSize();
    if (this.htmlFullScreen) {
      this.activeTab.view.setBounds({ x: 0, y: 0, width, height });
      return;
    }
    const sidebar = this.scaled(settings.get('sidebarCollapsed') ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH);
    const toolbar = this.scaled(TOOLBAR_HEIGHT);
    this.activeTab.view.setBounds({
      x: sidebar,
      y: toolbar,
      width: Math.max(0, width - sidebar),
      height: Math.max(0, height - toolbar),
    });
  }

  // The page view always paints above the UI. To let the UI draw over the page
  // area (address suggestions), the page is swapped for a still image of itself.
  async openOverlay() {
    if (this.overlayOpen || this.closed) return;
    this.overlayOpen = true;
    const tab = this.activeTab;
    let backdrop = null;
    try {
      const image = await tab.wc.capturePage();
      if (!image.isEmpty()) backdrop = 'data:image/jpeg;base64,' + image.toJPEG(82).toString('base64');
    } catch {
      // No snapshot (page not painted yet): the UI shows a plain backdrop.
    }
    if (this.overlayOpen && tab === this.activeTab) this.sendToUi('backdrop', backdrop);
  }

  closeOverlay() {
    if (!this.overlayOpen) return;
    this.overlayOpen = false;
    if (this.activeTab && this.activeTab.view) this.activeTab.view.setVisible(true);
    this.sendToUi('close-suggest');
  }

  // ------------------------------------------------------------ UI state

  sendToUi(channel, data) {
    if (!this.closed && !this.ui.isDestroyed()) this.ui.send('ui:' + channel, data);
  }

  toast(message) {
    this.sendToUi('toast', message);
  }

  sendState() {
    if (this.closed || this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (this.closed || !this.activeTab) return;
      const state = this.buildState();
      this.win.setTitle(`${state.title} - Buzz${this.isPrivate ? ' Private' : ''}`);
      this.sendToUi('state', state);
    }, 40);
  }

  buildState() {
    const tab = this.activeTab;
    const url = tab.wc.getURL();
    const { displayUrl, kind } = describeUrl(url);
    const host = isWebUrl(displayUrl) ? hostOf(displayUrl) : '';
    const history = tab.wc.navigationHistory;
    return {
      title: tab.title || 'New Tab',
      isPrivate: this.isPrivate,
      sidebarCollapsed: settings.get('sidebarCollapsed'),
      appearance: { scheme: settings.get('scheme'), font: settings.get('uiFont') },
      engineName: search.current().name,
      activeTabId: tab.id,
      tabs: this.tabs.map((t) => ({
        id: t.id,
        title: t.title || 'New Tab',
        favicon: t.favicon,
        internal: isInternalUrl(t.wc ? t.wc.getURL() : t.url),
        loading: t.loading,
        audible: t.audible,
        asleep: t.asleep,
      })),
      nav: {
        url: displayUrl,
        kind,
        loading: tab.loading,
        canGoBack: history.canGoBack(),
        canGoForward: history.canGoForward(),
        isReader: kind === 'reader',
        readerAvailable: kind === 'reader' || isWebUrl(url),
        readerable: tab.readerable,
      },
      shields: {
        engine: shields.engineState(),
        adblock: settings.get('adblock'),
        host,
        siteEnabled: host ? shields.isSiteEnabled(host) : true,
        blocked: shields.blockedOn(tab.wc.id),
      },
      downloads: downloads.summary(this.session, this.isPrivate),
    };
  }

  // ------------------------------------------------------------- actions

  handleAction(action, payload) {
    const tab = this.activeTab;
    if (this.closed || !tab) return undefined;
    switch (action) {
      case 'new-tab':
        return this.newTab();
      case 'close-tab':
        return this.closeTab(this.tabById(payload));
      case 'activate-tab':
        return this.activate(this.tabById(payload));
      case 'tab-menu':
        return this.showTabMenu(this.tabById(payload));
      case 'navigate':
        return this.navigate(payload);
      case 'back':
        return tab.wc.navigationHistory.goBack();
      case 'forward':
        return tab.wc.navigationHistory.goForward();
      case 'reload':
        return tab.wc.reload();
      case 'stop':
        return tab.wc.stop();
      case 'focus-page':
        return tab.wc.focus();
      case 'toggle-reader':
        return this.toggleReader(tab);
      case 'toggle-sidebar':
        return settings.set('sidebarCollapsed', !settings.get('sidebarCollapsed'));
      case 'toggle-site-shields':
        return this.toggleSiteShields(tab);
      case 'open-page':
        return Object.hasOwn(pages.APP_PAGES, payload) ? this.openInternal(payload) : undefined;
      case 'new-private-window':
        return new BuzzWindow({ isPrivate: true });
      case 'overlay-open':
        return this.openOverlay();
      case 'overlay-ready':
        if (this.overlayOpen) tab.view.setVisible(false);
        return undefined;
      case 'overlay-close':
        return this.closeOverlay();
      case 'chrome-colors':
        return this.setChromeColors(payload);
      case 'find':
        if (payload && typeof payload.text === 'string' && payload.text) {
          tab.wc.findInPage(payload.text, { forward: payload.forward !== false, findNext: payload.findNext === true });
        } else {
          tab.wc.stopFindInPage('clearSelection');
        }
        return undefined;
      case 'stop-find':
        tab.wc.stopFindInPage('clearSelection');
        return tab.wc.focus();
      default:
        return undefined;
    }
  }

  // The UI measures its own themed colours and reports them for the native title-bar buttons.
  setChromeColors(colors) {
    const hex = /^#[0-9a-f]{6}$/i;
    if (!colors || !hex.test(colors.bg) || !hex.test(colors.symbol)) return;
    this.applyTitleBar({ bg: colors.bg, symbol: colors.symbol });
    if (!this.isPrivate) {
      settings.set('chromeBg', colors.bg, { silent: true });
      settings.set('chromeSymbol', colors.symbol, { silent: true });
    }
  }

  navigate(input) {
    const url = fromAddressInput(typeof input === 'string' ? input : '');
    if (!url) return;
    this.closeOverlay();
    this.load(this.activeTab, url);
    this.activeTab.wc.focus();
  }

  // Rows for the address-bar dropdown: what was typed, matching history, then engine suggestions.
  async suggest(text) {
    const query = String(text || '').trim().slice(0, 200);
    if (!query) return [];
    const engine = search.current().name;
    const direct = typedUrl(query);
    const items = [
      direct
        ? { type: 'url', text: query, detail: 'Open address', url: direct }
        : { type: 'search', text: query, detail: `Search with ${engine}`, url: search.searchUrl(query) },
    ];
    if (!this.isPrivate) {
      for (const visit of store.suggestVisits(query, 4)) {
        if (visit.url !== direct) items.push({ type: 'history', text: visit.title || visit.url, detail: visit.url, url: visit.url });
      }
    }
    for (const phrase of await search.suggest(this.session, query)) {
      items.push({ type: 'search', text: phrase, detail: '', url: search.searchUrl(phrase) });
    }
    return items.slice(0, MAX_SUGGESTIONS);
  }

  focusAddress() {
    this.ui.focus();
    this.sendToUi('focus-address');
  }

  toggleSiteShields(tab) {
    const { displayUrl } = describeUrl(tab.wc.getURL());
    const host = isWebUrl(displayUrl) ? hostOf(displayUrl) : '';
    if (!host) return;
    shields.setSiteEnabled(host, !shields.isSiteEnabled(host));
    // Bypass the cache so previously loaded trackers are requested (and judged) again.
    if (isWebUrl(tab.wc.getURL())) tab.wc.reloadIgnoringCache();
  }

  async toggleReader(tab) {
    const wc = tab.wc;
    const url = wc.getURL();
    const { displayUrl, kind } = describeUrl(url);
    if (kind === 'reader') {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else if (isWebUrl(displayUrl)) this.load(tab, displayUrl);
      return;
    }
    if (!isWebUrl(url)) return;
    const article = await reader.extract(wc);
    if (this.closed || tab.wc !== wc || wc.isDestroyed() || wc.getURL() !== url) return;
    if (!article) {
      this.toast('Reader mode is not available for this page');
      return;
    }
    reader.store(this.session, url, article);
    this.load(tab, reader.readerUrl(url));
  }

  zoom(step) {
    const wc = this.activeTab.wc;
    wc.setZoomLevel(step === 0 ? 0 : Math.max(-3, Math.min(5, wc.getZoomLevel() + step * 0.5)));
  }

  handleShortcut(event, input) {
    if (input.type !== 'keyDown' || this.closed || !this.activeTab) return;
    const tab = this.activeTab;
    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    let handled = true;

    if (ctrl && !input.alt) {
      if (key === 't' && !input.shift) this.newTab();
      else if (key === 'w' && !input.shift) this.closeTab(tab);
      else if (key === 'n') new BuzzWindow({ isPrivate: input.shift });
      else if (key === 'l') this.focusAddress();
      else if (key === 'r') input.shift ? tab.wc.reloadIgnoringCache() : tab.wc.reload();
      else if (key === 'f' && !input.shift) {
        this.ui.focus();
        this.sendToUi('open-find');
      } else if (key === 'b' && !input.shift) this.handleAction('toggle-sidebar');
      else if (key === 'h' && !input.shift) this.openInternal('history');
      else if (key === 'j' && !input.shift) this.openInternal('downloads');
      else if (key === ',') this.openInternal('settings');
      else if (key === 'tab') this.cycleTab(input.shift ? -1 : 1);
      else if (/^[1-9]$/.test(key)) this.activate(this.tabs[key === '9' ? this.tabs.length - 1 : Number(key) - 1]);
      else if (key === '=' || key === '+') this.zoom(1);
      else if (key === '-') this.zoom(-1);
      else if (key === '0') this.zoom(0);
      else if (key === 'i' && input.shift) tab.wc.toggleDevTools();
      else handled = false;
    } else if (input.alt && !ctrl) {
      if (key === 'arrowleft') tab.wc.navigationHistory.goBack();
      else if (key === 'arrowright') tab.wc.navigationHistory.goForward();
      else if (key === 'd') this.focusAddress();
      else handled = false;
    } else if (!ctrl && !input.alt) {
      if (key === 'f5') tab.wc.reload();
      else if (key === 'f6') this.focusAddress();
      else if (key === 'f9') this.toggleReader(tab);
      else if (key === 'f11') this.win.setFullScreen(!this.win.isFullScreen());
      else if (key === 'f12') tab.wc.toggleDevTools();
      else handled = false;
    } else {
      handled = false;
    }
    if (handled) event.preventDefault();
  }

  showTabMenu(tab) {
    if (!tab) return;
    const url = tab.wc ? tab.wc.getURL() : tab.url;
    const items = [
      { label: 'Reload', enabled: !tab.asleep, click: () => tab.wc && tab.wc.reload() },
      { label: 'Duplicate', click: () => this.createTab(url, { opener: tab }) },
      { label: 'Copy address', enabled: isWebUrl(url), click: () => clipboard.writeText(url) },
      { type: 'separator' },
      {
        label: 'Put to sleep',
        enabled: !tab.asleep && tab !== this.activeTab && !tab.audible,
        click: () => this.sleepTab(tab),
      },
      { type: 'separator' },
      { label: 'Close', click: () => this.closeTab(tab) },
      {
        label: 'Close other tabs',
        enabled: this.tabs.length > 1,
        click: () => {
          this.activate(tab);
          for (const other of this.tabs.filter((t) => t !== tab)) this.closeTab(other);
        },
      },
    ];
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  showContextMenu(tab, params) {
    const wc = tab.wc;
    const items = [];
    const hasLink = isWebUrl(params.linkURL);
    const hasImage = params.mediaType === 'image' && isWebUrl(params.srcURL);
    const selection = (params.selectionText || '').trim();

    if (hasLink) {
      items.push(
        { label: 'Open link in new tab', click: () => this.createTab(params.linkURL, { active: false, opener: tab }) },
        { label: 'Open link in private window', click: () => new BuzzWindow({ isPrivate: true, url: params.linkURL }) },
        { label: 'Save link as…', click: () => wc.downloadURL(params.linkURL) },
        { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }
    if (hasImage) {
      items.push(
        { label: 'Open image in new tab', click: () => this.createTab(params.srcURL, { opener: tab }) },
        { label: 'Save image', click: () => wc.downloadURL(params.srcURL) },
        { label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) },
        { label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' },
      );
    }
    if (params.isEditable) {
      items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
    } else if (selection) {
      const preview = selection.length > 28 ? selection.slice(0, 28) + '…' : selection;
      items.push(
        { role: 'copy' },
        {
          label: `Search ${search.current().name} for "${preview}"`,
          click: () => this.createTab(search.searchUrl(selection), { opener: tab }),
        },
        { type: 'separator' },
      );
    }
    if (!hasLink && !hasImage && !params.isEditable && !selection) {
      const history = wc.navigationHistory;
      items.push(
        { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
        { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
      );
    }
    items.push({ label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }
}

module.exports = { BuzzWindow, MAIN_PARTITION };
