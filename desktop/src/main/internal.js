// The bridge between Buzz's own pages (buzz://settings, history, downloads)
// and the main process. Only those pages, in a tab's main frame, may call in.
const { app, dialog, ipcMain, nativeTheme, session } = require('electron');
const settings = require('./settings');
const search = require('./search');
const store = require('./store');
const downloads = require('./downloads');
const pages = require('./pages');
const { BuzzWindow, MAIN_PARTITION } = require('./window');
const { internalPage } = require('./urls');

const APPEARANCE_KEYS = new Set(['theme', 'scheme', 'uiFont', 'readerFont', 'readerSize', 'searchEngine']);

function callerOf(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !Object.hasOwn(pages.APP_PAGES, internalPage(frame.url))) return null;
  return BuzzWindow.forWebContents(event.sender);
}

function memoryStats() {
  const metrics = app.getAppMetrics();
  // privateBytes (Windows) is memory only Buzz uses; elsewhere fall back to the working set.
  const kilobytes = metrics.reduce((sum, m) => sum + (m.memory.privateBytes ?? m.memory.workingSetSize), 0);
  const tabs = BuzzWindow.all().flatMap((w) => w.tabs);
  return {
    megabytes: Math.round(kilobytes / 1024),
    processes: metrics.length,
    tabs: tabs.length,
    asleep: tabs.filter((t) => t.asleep).length,
  };
}

async function clearData({ since = 0, history = false, cookies = false, cache = false, downloadList = false } = {}) {
  const main = session.fromPartition(MAIN_PARTITION);
  const from = Number(since) > 0 ? Number(since) : 0;
  if (history) store.clearVisits(from);
  if (downloadList) downloads.clear(main, false, from);
  // Chromium can only clear site data and cache wholesale, not by time range.
  if (cookies) await main.clearStorageData();
  if (cache) await main.clearCache();
  broadcast('history');
}

const METHODS = {
  init: (win) => ({
    settings: settings.publicValues(),
    engines: search.list(),
    downloadDir: downloads.downloadDir(),
    isPrivate: win.isPrivate,
    version: app.getVersion(),
    chromium: process.versions.chrome,
  }),
  set: (_win, key, value) => settings.setFromUser(key, value),
  'choose-download-dir': async (win) => {
    const result = await dialog.showOpenDialog(win.win, {
      title: 'Choose where downloads are saved',
      defaultPath: downloads.downloadDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!result.canceled && result.filePaths[0]) settings.set('downloadDir', result.filePaths[0]);
    return downloads.downloadDir();
  },
  'clear-data': (_win, options) => clearData(options),
  memory: () => memoryStats(),
  'sleep-now': () => BuzzWindow.all().reduce((count, w) => count + w.tabs.filter((tab) => w.sleepTab(tab)).length, 0),
  history: (win, query) => (win.isPrivate ? [] : store.queryVisits(query && typeof query === 'object' ? query : {})),
  'history-remove': (win, id) => {
    if (!win.isPrivate && Number.isInteger(id)) store.removeVisit(id);
  },
  downloads: (win) => downloads.list(win.session, win.isPrivate),
  'download-action': (win, id, action) => downloads.act(win.session, win.isPrivate, id, action),
  'downloads-clear': (win) => downloads.clear(win.session, win.isPrivate),
};

// Send an event to every open Buzz app page.
function broadcast(name, data) {
  for (const win of BuzzWindow.all()) {
    for (const tab of win.tabs) {
      if (tab.wc && Object.hasOwn(pages.APP_PAGES, internalPage(tab.wc.getURL()))) tab.wc.send('internal:event', name, data);
    }
  }
}

// Static pages (new tab, reader) bake the theme in when served, so re-serve them.
function reloadStaticPages() {
  for (const win of BuzzWindow.all()) {
    for (const tab of win.tabs) {
      const name = tab.wc ? internalPage(tab.wc.getURL()) : '';
      if (name && !Object.hasOwn(pages.APP_PAGES, name)) tab.wc.reload();
    }
  }
}

function init() {
  nativeTheme.themeSource = settings.get('theme');

  ipcMain.handle('internal:invoke', (event, method, ...args) => {
    const win = callerOf(event);
    if (!win || !Object.hasOwn(METHODS, method)) throw new Error('Not allowed');
    return METHODS[method](win, ...args);
  });

  ipcMain.handle('ui:suggest', (event, text) => {
    const win = BuzzWindow.forUi(event.sender);
    return win ? win.suggest(text) : [];
  });

  settings.on('change', (key) => {
    if (key === 'theme') nativeTheme.themeSource = settings.get('theme');
    broadcast('settings', settings.publicValues());
    if (APPEARANCE_KEYS.has(key)) reloadStaticPages();
  });

  downloads.events.on('change', () => broadcast('downloads'));
  downloads.events.on('started', (record, wc) => {
    const win = wc && BuzzWindow.forWebContents(wc);
    if (!win) return;
    win.toast(`Downloading ${record.filename}`);
    // A tab opened only to start this download is left blank: close it.
    const tab = win.tabs.find((t) => t.wc === wc);
    if (tab && !wc.getURL() && win.tabs.length > 1) win.closeTab(tab);
  });
  downloads.events.on('done', (record) => {
    const message =
      record.state === 'completed' ? `Downloaded ${record.filename}` : record.state === 'cancelled' ? '' : `Download failed: ${record.filename}`;
    if (!message) return;
    const targets = record.session ? BuzzWindow.forSession(record.session) : BuzzWindow.all().filter((w) => !w.isPrivate);
    for (const win of targets) win.toast(message);
  });

  // Memory saver: once a minute, put tabs that have sat in the background to sleep.
  setInterval(() => {
    for (const win of BuzzWindow.all()) win.sleepIdleTabs();
  }, 60 * 1000).unref();
}

module.exports = { init, memoryStats };
