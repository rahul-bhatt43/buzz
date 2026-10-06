'use strict';

(async () => {
  const { h, start, main } = window.App;
  const call = window.buzz.call;
  const refreshers = []; // re-sync every control when settings change elsewhere

  const info = await start((next) => {
    values = next;
    for (const refresh of refreshers) refresh();
  });
  let values = info.settings;

  const set = (key, value) => call('set', key, value);

  function row(label, hint, ...controls) {
    return h(
      'div',
      { class: 'row' },
      h('div', { class: 'row-text' }, h('div', { class: 'row-label', text: label }), hint ? h('div', { class: 'row-hint' }, hint) : null),
      h('div', { class: 'row-control' }, ...controls),
    );
  }

  function section(id, title, ...rows) {
    return h('section', { class: 'section', id }, h('h2', { text: title }), h('div', { class: 'card' }, ...rows));
  }

  function segmented(key, options, { fonts = false } = {}) {
    const buttons = options.map(([value, label]) =>
      h('button', { type: 'button', text: label, 'data-font': fonts ? value : null, onclick: () => set(key, value) }),
    );
    refreshers.push(() => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === values[key]))));
    return h('div', { class: 'segmented', role: 'group' }, ...buttons);
  }

  function swatches(key, options) {
    const buttons = options.map(([value, label]) =>
      h('button', { type: 'button', class: 'swatch', 'data-value': value, title: label, 'aria-label': label, onclick: () => set(key, value) }, h('span')),
    );
    refreshers.push(() => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === values[key]))));
    return h('div', { class: 'swatches', role: 'group' }, ...buttons);
  }

  function toggle(key, label) {
    const button = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-label': label, onclick: () => set(key, !values[key]) });
    refreshers.push(() => button.setAttribute('aria-checked', String(values[key])));
    return button;
  }

  function select(key, options, label) {
    const el = h(
      'select',
      { class: 'field', 'aria-label': label, onchange: () => set(key, typeof values[key] === 'number' ? Number(el.value) : el.value) },
      ...options.map(([value, text]) => h('option', { value: String(value), text })),
    );
    refreshers.push(() => {
      el.value = String(values[key]);
    });
    return el;
  }

  const toggleRow = (key, label, hint) => row(label, hint, toggle(key, label));

  // ---------------------------------------------------------- privacy: clear data

  const clearRange = h(
    'select',
    { class: 'field', 'aria-label': 'Time range' },
    h('option', { value: '3600000', text: 'Last hour' }),
    h('option', { value: '86400000', text: 'Last 24 hours' }),
    h('option', { value: '604800000', text: 'Last 7 days' }),
    h('option', { value: '0', text: 'All time' }),
  );
  const check = (label, checked) => {
    const input = h('input', { type: 'checkbox', checked });
    return { input, el: h('label', {}, input, label) };
  };
  const checks = { history: check('History', true), downloadList: check('Download list', false), cookies: check('Cookies and site data', false), cache: check('Cache', false) };
  const clearButton = h('button', {
    type: 'button',
    class: 'button danger',
    text: 'Clear',
    onclick: async () => {
      const span = Number(clearRange.value);
      clearButton.disabled = true;
      await call('clear-data', {
        since: span ? Date.now() - span : 0,
        history: checks.history.input.checked,
        downloadList: checks.downloadList.input.checked,
        cookies: checks.cookies.input.checked,
        cache: checks.cache.input.checked,
      });
      clearButton.disabled = false;
      clearButton.textContent = 'Cleared';
      setTimeout(() => (clearButton.textContent = 'Clear'), 1800);
    },
  });
  const clearHint = h(
    'div',
    {},
    'The time range applies to history and the download list. Cookies and cache are always cleared in full.',
    h('div', { class: 'checks' }, ...Object.values(checks).map((c) => c.el)),
  );

  // ------------------------------------------------------------------ downloads

  const dirHint = h('span', { text: info.downloadDir });
  const dirButton = h('button', {
    type: 'button',
    class: 'button',
    text: 'Change…',
    onclick: async () => {
      dirHint.textContent = await call('choose-download-dir');
    },
  });

  // ---------------------------------------------------------------- performance

  const memoryFigure = h('span', { class: 'figure', text: '…' });
  const memoryHint = h('span', { text: 'Measuring…' });
  async function refreshMemory() {
    if (document.hidden) return;
    const stats = await call('memory');
    memoryFigure.textContent = `${new Intl.NumberFormat().format(stats.megabytes)} MB`;
    const awake = stats.tabs - stats.asleep;
    memoryHint.textContent = `${awake} ${awake === 1 ? 'tab' : 'tabs'} awake, ${stats.asleep} asleep, across all Buzz windows.`;
  }
  const sleepButton = h('button', {
    type: 'button',
    class: 'button',
    text: 'Sleep background tabs now',
    onclick: async () => {
      await call('sleep-now');
      setTimeout(refreshMemory, 1200);
    },
  });

  // --------------------------------------------------------------------- render

  main.append(
    section(
      'appearance',
      'Appearance',
      row('Theme', 'Light, dark, or follow Windows.', segmented('theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']])),
      row(
        'Colour',
        'Sets the accent and tints the whole browser.',
        swatches('scheme', [['honey', 'Honey'], ['clover', 'Clover'], ['lagoon', 'Lagoon'], ['poppy', 'Poppy'], ['heather', 'Heather'], ['graphite', 'Graphite']]),
      ),
      row(
        'Interface font',
        'Used for tabs, menus and Buzz pages.',
        segmented('uiFont', [['figtree', 'Figtree'], ['system', 'Segoe UI'], ['atkinson', 'Atkinson'], ['mono', 'Mono']], { fonts: true }),
      ),
      row('Interface size', 'Scales the sidebar and toolbar.', segmented('uiScale', [[0.9, 'Small'], [1, 'Default'], [1.1, 'Large'], [1.25, 'Larger']])),
      row(
        'Reader font',
        'The typeface for reader mode.',
        segmented('readerFont', [['serif', 'Literata'], ['sans', 'Figtree'], ['atkinson', 'Atkinson'], ['mono', 'Mono']], { fonts: true }),
      ),
      row('Reader text size', '', segmented('readerSize', [[16, 'S'], [17, 'M'], [19, 'L'], [21, 'XL'], [24, 'XXL']])),
    ),
    section(
      'search',
      'Search',
      row('Search engine', 'Used by the address bar and the new tab page.', select('searchEngine', info.engines.map((e) => [e.id, e.name]), 'Search engine')),
      toggleRow('suggestions', 'Search suggestions', 'Suggest searches as you type. What you type in the address bar is sent to your search engine.'),
    ),
    section(
      'privacy',
      'Shields & privacy',
      toggleRow('adblock', 'Block ads & trackers', 'You can still switch Shields off for a single site from the sidebar.'),
      toggleRow('httpsUpgrade', 'Upgrade connections to HTTPS', 'Buzz warns you before falling back to an insecure connection.'),
      toggleRow('clearOnExit', 'Clear data when Buzz closes', 'Removes history, cookies, site data and cache every time you quit.'),
      row('Clear browsing data', clearHint, clearRange, clearButton),
    ),
    section(
      'downloads',
      'Downloads',
      row('Save files to', dirHint, dirButton),
      toggleRow('askDownload', 'Ask where to save each file', ''),
    ),
    section(
      'performance',
      'Performance',
      toggleRow('memorySaver', 'Memory saver', 'Puts background tabs to sleep to free memory. A sleeping tab reloads when you return to it. Tabs playing audio stay awake.'),
      row('Sleep tabs after', 'How long a tab sits in the background before it sleeps.', select('sleepAfterMin', [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour']], 'Sleep tabs after')),
      row('Memory in use', memoryHint, memoryFigure, sleepButton),
    ),
    section('about', 'About', row('Buzz', `Version ${info.version}, built on Chromium ${info.chromium}.`)),
  );

  for (const refresh of refreshers) refresh();
  refreshMemory();
  setInterval(refreshMemory, 5000);
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
})();
