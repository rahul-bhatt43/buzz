// On-disk store for browsing history and the downloads list (SQLite, built into Node).
const { app } = require('electron');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hostOf } = require('./urls');

const HISTORY_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

let db = null;
const statements = new Map();

function open() {
  db = new DatabaseSync(path.join(app.getPath('userData'), 'buzz.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL DEFAULT '', time INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS visits_time ON visits (time);
    CREATE INDEX IF NOT EXISTS visits_host ON visits (host);
    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY, filename TEXT NOT NULL, path TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
      total INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, started INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0
    );
  `);
  run('DELETE FROM visits WHERE time < ?', Date.now() - HISTORY_DAYS * DAY_MS);
  // Downloads still marked as running were cut off when Buzz last closed.
  run("UPDATE downloads SET state = 'interrupted' WHERE state IN ('progressing', 'paused')");
}

function close() {
  if (!db) return;
  statements.clear();
  db.close();
  db = null;
}

function prepare(sql) {
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

const run = (sql, ...params) => prepare(sql).run(...params);
const all = (sql, ...params) => prepare(sql).all(...params);

// LIKE pattern matching `text` anywhere, with its own wildcards escaped.
function likePattern(text) {
  return '%' + text.replace(/[\\%_]/g, '\\$&') + '%';
}

// ---------------------------------------------------------------- history

function addVisit(url, title = '') {
  return Number(run('INSERT INTO visits (url, title, host, time) VALUES (?, ?, ?, ?)', url, title, hostOf(url), Date.now()).lastInsertRowid);
}

function setVisitTitle(id, title) {
  run('UPDATE visits SET title = ? WHERE id = ?', title, id);
}

function queryVisits({ text = '', before = 0, limit = 150 } = {}) {
  const cutoff = before > 0 ? before : Number.MAX_SAFE_INTEGER;
  if (!text) return all('SELECT id, url, title, time FROM visits WHERE time < ? ORDER BY time DESC LIMIT ?', cutoff, limit);
  const pattern = likePattern(text);
  return all(
    "SELECT id, url, title, time FROM visits WHERE time < ? AND (url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\') ORDER BY time DESC LIMIT ?",
    cutoff,
    pattern,
    pattern,
    limit,
  );
}

function removeVisit(id) {
  run('DELETE FROM visits WHERE id = ?', id);
}

function clearVisits(since = 0) {
  run('DELETE FROM visits WHERE time >= ?', since);
}

// Pages matching what is being typed, most visited first; hosts that start with the text win.
function suggestVisits(text, limit = 4) {
  const pattern = likePattern(text);
  return all(
    `SELECT url, MAX(title) AS title, COUNT(*) AS visits, MAX(time) AS last FROM visits
     WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
     GROUP BY url ORDER BY (host LIKE ? ESCAPE '\\') DESC, visits DESC, last DESC LIMIT ?`,
    pattern,
    pattern,
    pattern.slice(1),
    limit,
  );
}

function topSites(limit = 8) {
  return all(
    `SELECT host, MIN(url) AS url, COUNT(*) AS visits FROM visits WHERE host != ''
     GROUP BY host ORDER BY visits DESC, MAX(time) DESC LIMIT ?`,
    limit,
  ).map((row) => ({ host: row.host, url: new URL(row.url).origin + '/', visits: row.visits }));
}

// -------------------------------------------------------------- downloads

function addDownload({ filename, url, total, started }) {
  return Number(
    run("INSERT INTO downloads (filename, url, total, state, started) VALUES (?, ?, ?, 'progressing', ?)", filename, url, total, started).lastInsertRowid,
  );
}

function finishDownload({ id, filename, path: savedPath, total, state, ended }) {
  run('UPDATE downloads SET filename = ?, path = ?, total = ?, state = ?, ended = ? WHERE id = ?', filename, savedPath, total, state, ended, id);
}

function listDownloads(limit = 200) {
  return all('SELECT id, filename, path, url, total, state, started, ended FROM downloads ORDER BY started DESC LIMIT ?', limit);
}

function removeDownload(id) {
  run('DELETE FROM downloads WHERE id = ?', id);
}

function clearDownloads(since = 0) {
  run("DELETE FROM downloads WHERE started >= ? AND state NOT IN ('progressing', 'paused')", since);
}

module.exports = {
  open,
  close,
  addVisit,
  setVisitTitle,
  queryVisits,
  removeVisit,
  clearVisits,
  suggestVisits,
  topSites,
  addDownload,
  finishDownload,
  listDownloads,
  removeDownload,
  clearDownloads,
};
