// Buzz for Android: the in-app screens (new tab, search, tabs, shields,
// history, downloads, settings, warnings). The native side shows one screen at
// a time with Buzz.show(route, params) and answers call() through the bridge.
'use strict';

(() => {
  const { icon } = window.BuzzIcons;
  const app = document.getElementById('app');
  const number = new Intl.NumberFormat();

  // ---------------------------------------------------------------- bridge

  const waiting = new Map();
  let nextCall = 0;

  function call(method, ...args) {
    return new Promise((resolve) => {
      const id = ++nextCall;
      waiting.set(id, resolve);
      window.BuzzNative.post(id, method, JSON.stringify(args));
    });
  }

  // --------------------------------------------------------------- helpers

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

  const glyph = (name) => h('span', { class: 'icon' }, icon(name));
  const tool = (name, label, onclick) => h('button', { class: 'tool', 'aria-label': label, onclick }, glyph(name));

  function hueClass(host) {
    let hash = 0;
    for (const ch of host) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return `hue-${hash % 12}`;
  }

  function avatar(host, image) {
    if (image) return h('span', { class: 'avatar has-icon' }, h('img', { src: image, alt: '' }));
    return h('span', { class: `avatar ${hueClass(host)}`, text: (host[0] || 'b').toUpperCase() });
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 KB';
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }

  const empty = (title, text) => h('div', { class: 'empty' }, h('strong', { text: title }), text);

  /** A screen with a title bar and a back arrow that returns to the page. */
  function frame(title, ...children) {
    return [h('header', { class: 'bar' }, tool('back', 'Back', () => call('close-panel')), h('h1', { text: title })), ...children];
  }

  // ------------------------------------------------------------ appearance

  // The native toolbar and system bars are painted by Android, so it needs the
  // themed colours as plain hex values, for normal and for private tabs.
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  let reported = '';

  function toHex(cssColor) {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = cssColor;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  // A theme token such as --chrome holds an expression (light-dark(...), oklch(...)),
  // not a colour. Applying it to an element makes the browser resolve it.
  const swatch = document.createElement('span');
  swatch.hidden = true;
  document.documentElement.append(swatch);

  function readPalette() {
    const palette = {};
    for (const name of ['chrome', 'surface', 'ink', 'muted', 'line', 'accent']) {
      swatch.style.color = `var(--${name})`;
      palette[name] = toHex(getComputedStyle(swatch).color);
    }
    return palette;
  }

  function applyAppearance(state) {
    const root = document.documentElement;
    const { settings } = state;
    root.dataset.scheme = settings.scheme;
    root.dataset.font = settings.uiFont;
    // Where Android cannot switch the app theme itself, at least Buzz's own screens follow the choice.
    if (!state.canSetTheme && settings.theme !== 'system') root.dataset.theme = settings.theme;
    else delete root.dataset.theme;

    root.classList.remove('private');
    const normal = readPalette();
    root.classList.add('private');
    const hidden = readPalette();
    root.classList.toggle('private', state.active.private);
    const key = JSON.stringify([normal, hidden]);
    if (key !== reported) {
      reported = key;
      call('colors', { normal, private: hidden });
    }
  }

  // --------------------------------------------------------------- screens

  let state = null;
  let route = 'newtab';
  let params = {};
  let renderId = 0;
  let poll = null;

  const screens = {
    async newtab() {
      const sites = await call('top-sites');
      const hour = new Date().getHours();
      const greeting = state.active.private
        ? 'Private tab.'
        : hour < 5 || hour >= 22
          ? 'Up late.'
          : hour < 12
            ? 'Good morning.'
            : hour < 17
              ? 'Good afternoon.'
              : 'Good evening.';
      return [
        h('div', { class: 'comb' }),
        h(
          'main',
          { class: 'newtab' },
          h('div', { class: 'brand' }, h('img', { src: 'shared/logo.svg', alt: '' }), h('span', { class: 'wordmark', text: 'Buzz' })),
          h('div', { class: 'eyebrow', text: new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) }),
          h('h1', { class: 'greeting', text: greeting }),
          h('button', { class: 'fake-search', onclick: () => call('open-search') }, glyph('search'), `Search with ${state.engineName}`),
          state.active.private
            ? h('p', { class: 'note', text: 'Buzz forgets the history, cookies and site data of private tabs when you close them. Your network and the sites you visit can still see your activity.' })
            : null,
          sites.length
            ? h('div', { class: 'sites' }, ...sites.map((s) => h('button', { class: 'site', onclick: () => call('navigate', s.url) }, avatar(s.host), h('span', { text: s.host }))))
            : null,
          h('div', { class: 'stat' }, h('strong', { text: number.format(state.totalBlocked) }), h('span', { text: 'ads & trackers blocked' })),
        ),
      ];
    },

    search() {
      const input = h('input', {
        class: 'field',
        type: 'text',
        inputmode: 'url',
        enterkeyhint: 'go',
        autocapitalize: 'off',
        autocomplete: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
        placeholder: `Search ${state.engineName} or enter address`,
        'aria-label': 'Search or enter address',
      });
      input.value = params.text || '';
      const list = h('div', { class: 'suggestions' });
      const icons = { search: 'search', history: 'history', url: 'globe' };
      let request = 0;
      let timer = null;

      async function suggest() {
        const id = ++request;
        const items = input.value.trim() ? await call('suggest', input.value) : [];
        if (id !== request) return;
        list.replaceChildren(
          ...items.map((item) =>
            h(
              'button',
              { class: 'item', onclick: () => call('navigate', item.url) },
              glyph(icons[item.type] || 'search'),
              h('div', { class: 'item-body' }, h('div', { class: 'item-title', text: item.text }), item.detail ? h('div', { class: 'item-sub', text: item.detail }) : null),
            ),
          ),
        );
      }

      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(suggest, 110);
      });
      const form = h('form', { class: 'search-bar' }, input, h('button', { type: 'button', text: 'Cancel', onclick: () => call('close-panel') }));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (input.value.trim()) call('navigate', input.value);
      });
      // Focus after the screen is in the page, then ask Android for the keyboard.
      requestAnimationFrame(() => {
        input.focus();
        input.select();
        call('focus-input');
      });
      return [form, list];
    },

    tabs() {
      const cards = state.tabs.map((tab) =>
        h(
          'div',
          { class: `tab-card${tab.active ? ' active' : ''}${tab.asleep ? ' asleep' : ''}` },
          h(
            'button',
            { class: 'item', onclick: () => call('activate-tab', tab.id) },
            avatar(tab.host, tab.icon),
            h(
              'div',
              { class: 'item-body' },
              h('div', { class: 'item-title' }, tab.title, tab.private ? h('span', { class: 'tag', text: 'private' }) : null),
              h('div', { class: 'item-sub', text: tab.asleep ? `${tab.host} · asleep` : tab.host || 'Nothing open yet' }),
            ),
          ),
          tool('close', 'Close tab', () => call('close-tab', tab.id)),
        ),
      );
      return [
        ...frame(`Tabs · ${state.tabs.length}`),
        h('div', { class: 'body' }, h('div', { class: 'tab-list' }, ...cards)),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'button primary', onclick: () => call('new-tab', false) }, glyph('plus'), 'New tab'),
          h('button', { class: 'button', disabled: !state.privateSupported, onclick: () => call('new-tab', true) }, glyph('private'), 'Private tab'),
        ),
      ];
    },

    shields() {
      const { active, settings } = state;
      const up = settings.adblock && active.siteEnabled;
      let note = `${number.format(state.totalBlocked)} ads and trackers blocked in total.`;
      if (!settings.adblock) note = 'Ad blocking is switched off in Settings.';
      else if (state.shieldsState === 'loading') note = 'Loading filter lists…';
      else if (state.shieldsState === 'unavailable') note = 'Filter lists could not be downloaded. Buzz will try again next time it starts.';
      return [
        ...frame('Shields'),
        h(
          'div',
          { class: 'body' },
          h('div', { class: 'shields-hero' }, h('div', { class: 'figure', text: number.format(active.blocked) }), h('p', { text: `blocked on this page. Shields are ${up ? 'up' : 'down'}.` })),
          h(
            'div',
            { class: 'card' },
            h(
              'div',
              { class: 'row' },
              h('div', { class: 'row-text' }, h('div', { class: 'row-label', text: active.host ? `Protect ${active.host}` : 'Protect this site' }), h('div', { class: 'row-hint', text: 'Switch off if a site does not work properly.' })),
              h('button', { class: 'switch', role: 'switch', 'aria-checked': String(up), disabled: !active.host || !settings.adblock, onclick: () => call('toggle-site') }),
            ),
          ),
          h('p', { class: 'note', text: note }),
        ),
      ];
    },

    async history() {
      if (state.active.private) return [...frame('History'), h('div', { class: 'body' }, empty('Nothing is recorded here', 'Private tabs do not keep history.'))];
      const PAGE = 100;
      const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
      const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
      const list = h('div');
      const more = h('button', { class: 'button', text: 'Show older', hidden: true, onclick: () => load(false) });
      const search = h('input', { class: 'field', type: 'search', placeholder: 'Search history', 'aria-label': 'Search history' });
      let oldest = 0;
      let day = '';
      let card = null;
      let request = 0;

      function dayLabel(time) {
        const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const days = Math.round((start(new Date()) - start(new Date(time))) / 86400000);
        return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : dayFormat.format(time);
      }

      async function load(reset) {
        const id = ++request;
        const text = search.value.trim();
        const visits = await call('history', { text, before: reset ? 0 : oldest, limit: PAGE });
        if (id !== request) return;
        if (reset) {
          list.replaceChildren();
          day = '';
        }
        for (const visit of visits) {
          const label = dayLabel(visit.time);
          if (label !== day) {
            day = label;
            card = h('div', { class: 'card' });
            list.append(h('div', { class: 'day eyebrow', text: label }), card);
          }
          const host = hostOf(visit.url);
          const row = h(
            'div',
            { class: 'item' },
            avatar(host),
            h('div', { class: 'item-body', onclick: () => call('navigate', visit.url) }, h('div', { class: 'item-title', text: visit.title || visit.url }), h('div', { class: 'item-sub', text: `${timeFormat.format(visit.time)} · ${host}` })),
            tool('close', 'Remove from history', async () => {
              await call('history-remove', visit.id);
              row.remove();
            }),
          );
          card.append(row);
        }
        if (visits.length) oldest = visits[visits.length - 1].time;
        more.hidden = visits.length < PAGE;
        if (reset && !visits.length) list.append(empty(text ? 'No matches' : 'No history yet', text ? 'Nothing in your history matches that search.' : 'Pages you visit will show up here.'));
      }

      let timer = null;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => load(true), 150);
      });
      await load(true);
      return [...frame('History'), h('div', { class: 'body' }, search, h('div', { class: 'day' }), list, h('div', { class: 'day' }), more)];
    },

    async downloads() {
      const list = h('div');
      const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

      function status(d) {
        if (d.state === 'completed') return `${formatBytes(d.total)} · ${d.host} · ${dateFormat.format(d.time)}`;
        if (d.state === 'failed') return 'Download failed';
        if (d.state === 'paused') return `Waiting · ${formatBytes(d.received)}`;
        return d.total ? `${formatBytes(d.received)} of ${formatBytes(d.total)}` : formatBytes(d.received);
      }

      async function refresh() {
        const downloads = (await call('downloads')).sort((a, b) => b.time - a.time);
        if (!downloads.length) {
          list.replaceChildren(empty('No downloads yet', 'Files you download are saved to your Downloads folder and listed here.'));
          return;
        }
        const rows = downloads.map((d) => {
          const running = d.state === 'progressing' || d.state === 'paused';
          const fill = h('span');
          fill.style.width = `${d.total ? Math.min(100, (d.received / d.total) * 100) : 0}%`;
          return h(
            'div',
            { class: 'item' },
            h('span', { class: 'avatar has-icon' }, glyph(d.state === 'failed' ? 'warning' : running ? 'downloads' : 'file')),
            h(
              'div',
              { class: 'item-body', onclick: d.state === 'completed' ? () => call('download-open', d.id) : null },
              h('div', { class: 'item-title', text: d.filename }),
              h('div', { class: `item-sub${d.state === 'failed' ? ' failed' : ''}`, text: status(d) }),
              running ? h('div', { class: 'bar-track' }, fill) : null,
            ),
            tool('trash', running ? 'Cancel download' : 'Delete file', async () => {
              await call('download-remove', d.id);
              refresh();
            }),
          );
        });
        list.replaceChildren(h('div', { class: 'card' }, ...rows));
      }

      await refresh();
      // Android's download manager has no change events, so poll while this screen is open.
      poll = setInterval(refresh, 1500);
      return [...frame('Downloads'), h('div', { class: 'body' }, list)];
    },

    settings() {
      const s = state.settings;
      const set = async (key, value) => {
        await call('set', key, value);
        render();
      };
      const row = (label, hint, ...controls) =>
        h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('div', { class: 'row-label', text: label }), hint ? h('div', { class: 'row-hint' }, hint) : null), h('div', { class: 'row-control' }, ...controls));
      const section = (title, ...rows) => h('section', { class: 'section' }, h('span', { class: 'eyebrow', text: title }), h('div', { class: 'card' }, ...rows));
      const segmented = (key, options, fonts) =>
        h('div', { class: 'segmented' }, ...options.map(([value, label]) => h('button', { text: label, 'data-font': fonts ? value : null, 'aria-pressed': String(String(s[key]) === String(value)), onclick: () => set(key, value) })));
      const swatches = (key, options) =>
        h('div', { class: 'swatches' }, ...options.map(([value, label]) => h('button', { class: 'swatch', 'data-value': value, 'aria-label': label, 'aria-pressed': String(s[key] === value), onclick: () => set(key, value) }, h('span'))));
      const toggle = (key, label, hint) => row(label, hint, h('button', { class: 'switch', role: 'switch', 'aria-label': label, 'aria-checked': String(s[key]), onclick: () => set(key, !s[key]) }));

      const engine = h('select', { class: 'field', 'aria-label': 'Search engine' }, ...state.engines.map((e) => h('option', { value: e.id, text: e.name })));
      engine.value = s.searchEngine;
      engine.addEventListener('change', () => set('searchEngine', engine.value));

      const range = h('select', { class: 'field', 'aria-label': 'Time range' }, h('option', { value: '3600000', text: 'Last hour' }), h('option', { value: '86400000', text: 'Last 24 hours' }), h('option', { value: '0', text: 'All time' }));
      const box = (label, checked) => {
        const input = h('input', { type: 'checkbox', checked });
        return { input, el: h('label', {}, input, label) };
      };
      const boxes = { history: box('History', true), cookies: box('Cookies and site data', false), cache: box('Cache', false) };
      const clear = h('button', {
        class: 'button danger',
        text: 'Clear',
        onclick: async () => {
          const span = Number(range.value);
          clear.disabled = true;
          await call('clear-data', { since: span ? Date.now() - span : 0, history: boxes.history.input.checked, cookies: boxes.cookies.input.checked, cache: boxes.cache.input.checked });
          clear.disabled = false;
          clear.textContent = 'Cleared';
          setTimeout(() => (clear.textContent = 'Clear'), 1800);
        },
      });

      return [
        ...frame('Settings'),
        h(
          'div',
          { class: 'body' },
          section(
            'Appearance',
            row('Theme', state.canSetTheme ? 'Light, dark, or follow your phone.' : 'On this Android version, websites always follow your phone.', segmented('theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']])),
            row('Colour', 'Sets the accent and tints the whole browser.', swatches('scheme', [['honey', 'Honey'], ['clover', 'Clover'], ['lagoon', 'Lagoon'], ['poppy', 'Poppy'], ['heather', 'Heather'], ['graphite', 'Graphite']])),
            row('Font', 'Used on Buzz screens.', segmented('uiFont', [['figtree', 'Figtree'], ['system', 'System'], ['atkinson', 'Atkinson'], ['mono', 'Mono']], true)),
          ),
          section(
            'Reader mode',
            row('Reader font', '', segmented('readerFont', [['serif', 'Literata'], ['sans', 'Figtree'], ['atkinson', 'Atkinson'], ['mono', 'Mono']], true)),
            row('Text size', '', segmented('readerSize', [['16', 'S'], ['17', 'M'], ['19', 'L'], ['21', 'XL'], ['24', 'XXL']])),
          ),
          section('Search', row('Search engine', 'Used by the address bar and new tabs.', engine), toggle('suggestions', 'Search suggestions', 'What you type in the address bar is sent to your search engine.')),
          section(
            'Shields & privacy',
            toggle('adblock', 'Block ads & trackers', 'You can still switch Shields off for a single site.'),
            toggle('httpsUpgrade', 'Upgrade connections to HTTPS', 'Buzz warns you before falling back to an insecure connection.'),
            row('Clear browsing data', h('div', {}, 'The time range applies to history. Cookies and cache are cleared in full.', h('div', { class: 'checks' }, ...Object.values(boxes).map((b) => b.el))), range, clear),
          ),
          section('Performance', toggle('memorySaver', 'Memory saver', 'Keeps only your three most recent tabs loaded. Other tabs sleep and reload when you return to them.')),
          section('About', row('Buzz for Android', `Version ${state.version}. Pages are rendered by Android System WebView ${state.webview} (Chromium).`)),
        ),
      ];
    },

    insecure() {
      return [
        h(
          'main',
          { class: 'notice' },
          h('img', { src: 'shared/logo.svg', alt: '' }),
          h('h1', { text: 'This site does not support a secure connection' }),
          h('p', {}, 'Buzz tried to upgrade ', h('strong', { text: params.host || 'this site' }), ' to HTTPS, but the site did not respond securely.'),
          h('p', { text: 'Over plain HTTP, anyone on your network can read or change what you send and receive. Avoid entering passwords or payment details.' }),
          h('div', { class: 'stack' }, h('button', { class: 'button primary', text: 'Go back', onclick: () => call('insecure-back') }), h('button', { class: 'button', text: 'Continue to the HTTP site', onclick: () => call('proceed-insecure', params.url) })),
        ),
      ];
    },
  };

  async function render() {
    const id = ++renderId;
    clearInterval(poll);
    state = await call('state');
    if (id !== renderId) return;
    applyAppearance(state);
    const content = await screens[route]();
    if (id !== renderId) return;
    const sameScreen = document.body.dataset.route === route;
    document.body.dataset.route = route;
    app.replaceChildren(...content);
    // Re-rendering the screen you are on (flipping a setting) keeps your place.
    if (!sameScreen) window.scrollTo(0, 0);
  }

  // Screens that mirror live browser state and should follow it while open.
  const LIVE = new Set(['tabs', 'shields']);

  window.Buzz = {
    show(nextRoute, nextParams) {
      route = screens[nextRoute] ? nextRoute : 'newtab';
      params = nextParams || {};
      render();
    },
    resolve(id, result) {
      const resolve = waiting.get(id);
      waiting.delete(id);
      if (resolve) resolve(result);
    },
    onEvent(name) {
      if (name === 'state' && LIVE.has(route)) render();
    },
    // The native side put the page back on top: stop background work.
    hidden() {
      clearInterval(poll);
      delete document.body.dataset.route;
    },
  };

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
  call('ready');
})();
