// Download manager: saves files, tracks progress and keeps the downloads list.
const { app, shell } = require('electron');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const settings = require('./settings');
const store = require('./store');

const events = new EventEmitter(); // 'change', 'started' (record), 'done' (record)
const records = []; // newest first
const liveItems = new Map(); // record id -> DownloadItem
let nextPrivateId = -1;
const PROGRESS_INTERVAL_MS = 300;

function init() {
  for (const row of store.listDownloads()) {
    records.push({ ...row, received: row.state === 'completed' ? row.total : 0, session: null });
  }
}

function downloadDir() {
  const dir = settings.get('downloadDir');
  try {
    if (dir && fs.statSync(dir).isDirectory()) return dir;
  } catch {
    // Folder is gone: fall back to the system Downloads folder.
  }
  return app.getPath('downloads');
}

// Paths claimed by downloads still in progress. Their files do not exist under
// the final name yet, so checking the disk alone would hand out the same name twice.
const reservedPaths = new Set();
const taken = (file) => fs.existsSync(file) || reservedPaths.has(file.toLowerCase());

// "report.pdf" -> "report (1).pdf" when the name is taken.
function uniquePath(dir, filename) {
  const { name, ext } = path.parse(filename);
  let candidate = path.join(dir, filename);
  for (let n = 1; taken(candidate); n++) candidate = path.join(dir, `${name} (${n})${ext}`);
  return candidate;
}

function attachToSession(ses, { isPrivate }) {
  ses.on('will-download', (_event, item, wc) => {
    const dir = downloadDir();
    const filename = item.getFilename();
    let reserved = '';
    if (settings.get('askDownload')) {
      item.setSaveDialogOptions({ defaultPath: path.join(dir, filename) });
    } else {
      const target = uniquePath(dir, filename);
      reserved = target.toLowerCase();
      reservedPaths.add(reserved);
      item.setSavePath(target);
    }

    const started = Date.now();
    const url = item.getURL();
    const total = item.getTotalBytes();
    const record = {
      // Private downloads are never written to disk as history, so they get throwaway ids.
      id: isPrivate ? nextPrivateId-- : store.addDownload({ filename, url, total, started }),
      filename,
      path: '',
      url,
      total,
      received: 0,
      state: 'progressing',
      started,
      ended: 0,
      session: isPrivate ? ses : null,
    };
    records.unshift(record);
    liveItems.set(record.id, item);

    let lastEmit = 0;
    item.on('updated', (_e, state) => {
      const next = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      const stateChanged = next !== record.state;
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes();
      record.state = next;
      // Progress ticks arrive many times a second; listeners only need a few.
      if (!stateChanged && Date.now() - lastEmit < PROGRESS_INTERVAL_MS) return;
      lastEmit = Date.now();
      events.emit('change');
    });
    item.once('done', (_e, state) => {
      liveItems.delete(record.id);
      reservedPaths.delete(reserved);
      const savedPath = item.getSavePath();
      if (state === 'cancelled' && !savedPath) {
        // The save dialog was dismissed: this download never really started.
        remove(record);
        return;
      }
      record.state = state;
      record.path = savedPath;
      record.filename = savedPath ? path.basename(savedPath) : record.filename;
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes() || record.received;
      record.ended = Date.now();
      if (!isPrivate) store.finishDownload(record);
      events.emit('done', record);
      events.emit('change');
    });

    events.emit('started', record, wc);
    events.emit('change');
  });
}

function remove(record) {
  const index = records.indexOf(record);
  if (index >= 0) records.splice(index, 1);
  if (record.id > 0) store.removeDownload(record.id);
  events.emit('change');
}

// A window sees its own private downloads, or all the regular ones.
function visibleTo(ses, isPrivate) {
  return records.filter((r) => (isPrivate ? r.session === ses : r.session === null));
}

function list(ses, isPrivate) {
  return visibleTo(ses, isPrivate).map(({ session: _session, ...record }) => record);
}

function summary(ses, isPrivate) {
  const active = visibleTo(ses, isPrivate).filter((r) => r.state === 'progressing' || r.state === 'paused');
  const total = active.reduce((sum, r) => sum + r.total, 0);
  const received = active.reduce((sum, r) => sum + r.received, 0);
  return { active: active.length, progress: total > 0 ? Math.min(1, received / total) : 0 };
}

function act(ses, isPrivate, id, action) {
  const record = visibleTo(ses, isPrivate).find((r) => r.id === id);
  if (!record) return;
  const item = liveItems.get(id);
  switch (action) {
    case 'pause':
      if (item) item.pause();
      break;
    case 'resume':
      if (item && item.canResume()) item.resume();
      break;
    case 'cancel':
      if (item) item.cancel();
      break;
    case 'open':
      if (record.state === 'completed' && record.path) shell.openPath(record.path);
      break;
    case 'show':
      if (record.path) shell.showItemInFolder(record.path);
      break;
    case 'remove':
      if (!item) remove(record);
      break;
    default:
      break;
  }
}

// Forget finished downloads (the files themselves stay on disk).
function clear(ses, isPrivate, since = 0) {
  for (const record of visibleTo(ses, isPrivate)) {
    if (!liveItems.has(record.id) && record.started >= since) {
      records.splice(records.indexOf(record), 1);
    }
  }
  if (!isPrivate) store.clearDownloads(since);
  events.emit('change');
}

function forgetSession(ses) {
  for (const record of records.filter((r) => r.session === ses)) {
    const item = liveItems.get(record.id);
    if (item) item.cancel();
    records.splice(records.indexOf(record), 1);
  }
}

module.exports = { events, init, attachToSession, downloadDir, list, summary, act, clear, forgetSession };
