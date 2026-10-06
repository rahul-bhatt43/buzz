// Shared helpers for the buzz:// app pages (settings, history, downloads).
'use strict';

(() => {
  const { icon, hydrate } = window.BuzzIcons;

  // h('button', { class: 'tool', onclick: fn }, child, 'text') -> element
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === false || value == null) continue;
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key in el && typeof value !== 'string') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    el.append(...children.filter((child) => child != null && child !== false));
    return el;
  }

  function tool(name, label, onclick) {
    return h('button', { class: 'tool', title: label, 'aria-label': label, onclick }, icon(name));
  }

  function applyAppearance(settings) {
    const root = document.documentElement;
    root.dataset.scheme = settings.scheme;
    root.dataset.font = settings.uiFont;
    root.dataset.readerFont = settings.readerFont;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  // The same 0-11 colour bucket per host that the new tab page uses.
  function hueClass(host) {
    let hash = 0;
    for (const ch of host) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return `hue-${hash % 12}`;
  }

  function avatar(host) {
    return h('span', { class: `avatar ${hueClass(host)}`, text: (host[0] || '?').toUpperCase(), 'aria-hidden': 'true' });
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 KB';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }

  // Load page data and keep the theme in step with settings changes.
  async function start(onSettings) {
    hydrate();
    const info = await window.buzz.call('init');
    applyAppearance(info.settings);
    window.buzz.on('settings', (settings) => {
      applyAppearance(settings);
      if (onSettings) onSettings(settings);
    });
    return info;
  }

  window.App = { h, icon, tool, avatar, hostOf, formatBytes, start, main: document.getElementById('app') };
})();
