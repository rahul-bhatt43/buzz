const { app } = require('electron');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const oneOf = (...values) => (v) => values.includes(v);
const bool = (v) => typeof v === 'boolean';

// Every setting: its default, and a validator when pages are allowed to change it.
const SCHEMA = {
  // Appearance
  theme: { default: 'system', valid: oneOf('system', 'light', 'dark') },
  scheme: { default: 'honey', valid: oneOf('honey', 'clover', 'lagoon', 'poppy', 'heather', 'graphite') },
  uiFont: { default: 'figtree', valid: oneOf('figtree', 'system', 'atkinson', 'mono') },
  uiScale: { default: 1, valid: oneOf(0.9, 1, 1.1, 1.25) },
  readerFont: { default: 'serif', valid: oneOf('serif', 'sans', 'atkinson', 'mono') },
  readerSize: { default: 19, valid: oneOf(16, 17, 19, 21, 24) },
  // Search
  searchEngine: { default: 'duckduckgo', valid: oneOf('duckduckgo', 'google', 'bing', 'brave', 'startpage', 'ecosia') },
  suggestions: { default: true, valid: bool },
  // Shields and privacy
  adblock: { default: true, valid: bool },
  httpsUpgrade: { default: true, valid: bool },
  clearOnExit: { default: false, valid: bool },
  // Downloads
  downloadDir: { default: '' },
  askDownload: { default: false, valid: bool },
  // Performance
  memorySaver: { default: true, valid: bool },
  sleepAfterMin: { default: 15, valid: oneOf(5, 15, 30, 60) },
  // Internal state
  sidebarCollapsed: { default: false },
  shieldsOffHosts: { default: [] },
  totalBlocked: { default: 0 },
  chromeBg: { default: '' },
  chromeSymbol: { default: '' },
};

class Settings extends EventEmitter {
  constructor() {
    super();
    this.data = {};
    for (const [key, spec] of Object.entries(SCHEMA)) this.data[key] = spec.default;
    this.file = null;
    this.timer = null;
  }

  load() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [key, spec] of Object.entries(SCHEMA)) {
        const value = stored[key];
        if (typeof value !== typeof spec.default || Array.isArray(value) !== Array.isArray(spec.default)) continue;
        if (!spec.valid || spec.valid(value)) this.data[key] = value;
      }
    } catch {
      // First run or unreadable file: keep defaults.
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value, { silent = false } = {}) {
    if (!(key in SCHEMA) || this.data[key] === value) return;
    this.data[key] = value;
    this.scheduleSave();
    if (!silent) this.emit('change', key);
  }

  // A change requested by the UI or a settings page: only validated keys pass.
  setFromUser(key, value) {
    const spec = Object.hasOwn(SCHEMA, key) ? SCHEMA[key] : null;
    if (!spec || !spec.valid || !spec.valid(value)) return false;
    this.set(key, value);
    return true;
  }

  // The user-facing settings, for the settings page.
  publicValues() {
    const values = {};
    for (const [key, spec] of Object.entries(SCHEMA)) {
      if (spec.valid) values[key] = this.data[key];
    }
    return values;
  }

  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('Could not save settings:', err.message);
    }
  }
}

module.exports = new Settings();
