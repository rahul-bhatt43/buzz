const { app, ipcMain, Menu, protocol, session } = require('electron');
const os = require('node:os');
const path = require('node:path');
const settings = require('./settings');
const shields = require('./shields');
const store = require('./store');
const downloads = require('./downloads');
const internal = require('./internal');
const tor = require('./tor');
const { BuzzWindow, MAIN_PARTITION } = require('./window');
const { isWebUrl } = require('./urls');

const SMOKE = process.argv.includes('--smoke');

if (SMOKE) {
  // Self-test run: throwaway profile, and a fake hostname pointing at loopback.
  app.setPath('userData', path.join(os.tmpdir(), `buzz-smoke-${process.pid}`));
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP insecure.test 127.0.0.1');
}

// Memory: let tabs on the same site share one process, and do not keep a
// spare renderer process warm in the background.
app.commandLine.appendSwitch('process-per-site');
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess');

// Without its own id, Windows groups Buzz under Electron's taskbar icon.
app.setAppUserModelId('com.buzz.browser');

protocol.registerSchemesAsPrivileged([{ scheme: 'buzz', privileges: { standard: true, secure: true } }]);

// Present as plain Chrome; sites that sniff for Electron tend to break.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|buzz)\/\S+/gi, '');

function openWindow(argv = []) {
  const url = argv.find((arg) => isWebUrl(arg));
  return new BuzzWindow(url ? { url } : {});
}

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => openWindow(argv.slice(1)));

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  ipcMain.on('ui:action', (event, action, payload) => {
    const win = BuzzWindow.forUi(event.sender);
    if (win && typeof action === 'string') win.handleAction(action, payload);
  });

  app.on('window-all-closed', () => app.quit());

  let exitCleanupDone = false;
  app.on('will-quit', (event) => {
    tor.stop();
    settings.flush();
    if (exitCleanupDone || !settings.get('clearOnExit')) {
      store.close();
      return;
    }
    exitCleanupDone = true;
    event.preventDefault();
    const main = session.fromPartition(MAIN_PARTITION);
    store.clearVisits();
    downloads.clear(main, false);
    Promise.allSettled([main.clearStorageData(), main.clearCache()]).then(() => app.quit());
  });

  app.whenReady().then(() => {
    // Shortcuts are handled per window in BuzzWindow.handleShortcut.
    Menu.setApplicationMenu(null);
    settings.load();
    store.open();
    downloads.init();
    shields.init();
    internal.init();
    if (SMOKE) {
      require('../../test/smoke').run();
    } else {
      openWindow(process.argv.slice(1));
    }
  });
}
