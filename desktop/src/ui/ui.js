'use strict';

const { icon, setIcon, hydrate } = window.BuzzIcons;
const $ = (id) => document.getElementById(id);
const send = (action, payload) => window.buzz.send(action, payload);
const number = new Intl.NumberFormat();

const els = {
  tabs: $('tabs'),
  tabCount: $('tab-count'),
  address: $('address'),
  addressForm: $('address-form'),
  security: $('security'),
  back: $('back'),
  forward: $('forward'),
  reload: $('reload'),
  reader: $('reader'),
  toast: $('toast'),
  shields: $('shields'),
  shieldsState: $('shields-state'),
  siteSwitch: $('site-switch'),
  siteSwitchLabel: $('site-switch-label'),
  shieldsNote: $('shields-note'),
  toolbarShields: $('toolbar-shields'),
  downloads: $('open-downloads'),
  findForm: $('find-form'),
  findInput: $('find-input'),
  findCount: $('find-count'),
  content: $('content'),
  backdrop: $('backdrop'),
  suggest: $('suggest'),
};

let state = null;
let shownUrl = null; // the page URL the address bar was last synced to
let shownTabId = null;
let addressEdited = false;

const windowKind = new URLSearchParams(location.search);
if (windowKind.get('private') === '1') document.documentElement.classList.add('private');
if (windowKind.get('tor') === '1') document.querySelector('.private-tag').textContent = 'tor';
hydrate();

// ------------------------------------------------------------- appearance

// The native minimise/maximise/close buttons are painted by the OS, so the
// main process needs the themed toolbar colours as plain hex values.
const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
let reportedColors = '';

function toHex(cssColor) {
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = cssColor;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function reportChromeColors() {
  const style = getComputedStyle(document.body);
  const colors = { bg: toHex(style.backgroundColor), symbol: toHex(style.color) };
  const key = colors.bg + colors.symbol;
  if (key === reportedColors) return;
  reportedColors = key;
  send('chrome-colors', colors);
}

function applyAppearance() {
  const root = document.documentElement;
  root.dataset.scheme = state.appearance.scheme;
  root.dataset.font = state.appearance.font;
  reportChromeColors();
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => requestAnimationFrame(reportChromeColors));

// ------------------------------------------------------------------- tabs

const tabEls = new Map(); // tab id -> { root, main, iconBox, title, flag }

function createTabEl(id) {
  const root = document.createElement('div');
  root.className = 'tab';

  const main = document.createElement('button');
  main.className = 'tab-main';
  main.setAttribute('role', 'tab');
  const iconBox = document.createElement('span');
  iconBox.className = 'tab-icon';
  const title = document.createElement('span');
  title.className = 'tab-title';
  const flag = document.createElement('span');
  flag.className = 'tab-flag icon';
  flag.hidden = true;
  main.append(iconBox, title, flag);

  const close = document.createElement('button');
  close.className = 'tab-close';
  close.title = 'Close tab (Ctrl+W)';
  close.setAttribute('aria-label', 'Close tab');
  close.append(icon('close'));

  main.addEventListener('click', () => send('activate-tab', id));
  close.addEventListener('click', () => send('close-tab', id));
  root.addEventListener('auxclick', (e) => {
    if (e.button === 1) send('close-tab', id);
  });
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    send('tab-menu', id);
  });

  root.append(main, close);
  return { root, main, iconBox, title, flag, iconKey: null };
}

function renderTabIcon(el, tab) {
  const key = tab.loading ? 'loading' : tab.favicon || (tab.internal ? 'buzz' : 'globe');
  if (el.iconKey === key) return;
  el.iconKey = key;
  if (tab.loading) {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    el.iconBox.replaceChildren(spinner);
  } else if (tab.favicon || tab.internal) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = tab.favicon || '../assets/logo.svg';
    el.iconBox.replaceChildren(img);
  } else {
    el.iconBox.replaceChildren(icon('globe'));
  }
}

function renderTabs() {
  const seen = new Set();
  let previous = null;
  for (const tab of state.tabs) {
    seen.add(tab.id);
    let el = tabEls.get(tab.id);
    if (!el) {
      el = createTabEl(tab.id);
      tabEls.set(tab.id, el);
    }
    const active = tab.id === state.activeTabId;
    el.root.classList.toggle('active', active);
    el.root.classList.toggle('asleep', tab.asleep);
    el.main.setAttribute('aria-selected', String(active));
    el.main.title = tab.asleep ? `${tab.title} (asleep to save memory)` : tab.title;
    if (el.title.textContent !== tab.title) el.title.textContent = tab.title;
    el.flag.hidden = !tab.audible && !tab.asleep;
    if (!el.flag.hidden) setIcon(el.flag, tab.audible ? 'volume' : 'moon');
    renderTabIcon(el, tab);

    // Keep DOM order in step with tab order without rebuilding the list.
    const expected = previous ? previous.nextSibling : els.tabs.firstChild;
    if (expected !== el.root) els.tabs.insertBefore(el.root, expected);
    previous = el.root;
  }
  for (const [id, el] of tabEls) {
    if (!seen.has(id)) {
      el.root.remove();
      tabEls.delete(id);
    }
  }
  els.tabCount.textContent = String(state.tabs.length);
  if (shownTabId !== state.activeTabId) {
    tabEls.get(state.activeTabId)?.root.scrollIntoView({ block: 'nearest' });
  }
}

// ---------------------------------------------------------------- toolbar

const SECURITY = {
  secure: { icon: 'lock', title: 'Connection is secure' },
  insecure: { icon: 'warning', title: 'Connection is not secure' },
  reader: { icon: 'book', title: 'Reader mode' },
  internal: { icon: 'search', title: 'Search or enter address' },
};

function renderToolbar() {
  const { nav } = state;
  els.back.disabled = !nav.canGoBack;
  els.forward.disabled = !nav.canGoForward;
  setIcon(els.reload, nav.loading ? 'close' : 'reload');
  els.reload.title = nav.loading ? 'Stop loading (Esc)' : 'Reload (Ctrl+R)';
  els.reload.setAttribute('aria-label', nav.loading ? 'Stop loading' : 'Reload');

  const security = SECURITY[nav.kind] || SECURITY.internal;
  setIcon(els.security, security.icon);
  els.security.className = 'icon ' + nav.kind;
  els.security.title = security.title;

  els.reader.disabled = !nav.readerAvailable;
  els.reader.setAttribute('aria-pressed', String(nav.isReader));
  els.reader.classList.toggle('suggested', nav.readerable && !nav.isReader);
  els.reader.title = nav.isReader ? 'Leave reader mode (F9)' : 'Reader mode (F9)';
  els.address.placeholder = `Search ${state.engineName} or enter address`;

  const tabChanged = shownTabId !== state.activeTabId;
  if (tabChanged || nav.url !== shownUrl) {
    const typing = document.activeElement === els.address && addressEdited && !tabChanged;
    if (!typing) {
      els.address.value = nav.url;
      addressEdited = false;
    }
    shownUrl = nav.url;
  }

  const { downloads } = state;
  els.downloads.classList.toggle('active', downloads.active > 0);
  els.downloads.style.setProperty('--progress', String(downloads.progress));
  els.downloads.title = downloads.active > 0 ? `Downloads: ${downloads.active} in progress (Ctrl+J)` : 'Downloads (Ctrl+J)';
}

els.back.addEventListener('click', () => send('back'));
els.forward.addEventListener('click', () => send('forward'));
els.reload.addEventListener('click', () => send(state && state.nav.loading ? 'stop' : 'reload'));
els.reader.addEventListener('click', () => send('toggle-reader'));
$('toggle-sidebar').addEventListener('click', () => send('toggle-sidebar'));
$('new-tab').addEventListener('click', () => send('new-tab'));
$('new-private').addEventListener('click', () => send('private-menu'));
$('open-history').addEventListener('click', () => send('open-page', 'history'));
$('open-downloads').addEventListener('click', () => send('open-page', 'downloads'));
$('open-settings').addEventListener('click', () => send('open-page', 'settings'));
els.tabs.addEventListener('dblclick', (e) => {
  if (e.target === els.tabs) send('new-tab');
});

let toastTimer = null;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
}

// ---------------------------------------------- address bar + suggestions

const SUGGEST_DELAY_MS = 90;
const SUGGEST_ICONS = { search: 'search', history: 'history', url: 'globe' };

let suggestions = [];
let selected = -1;
let suggestOpen = false;
let suggestRequest = 0; // bumped to drop answers to stale requests
let suggestTimer = null;

function placeSuggestions() {
  const form = els.addressForm.getBoundingClientRect();
  const area = els.content.getBoundingClientRect();
  els.suggest.style.left = `${form.left - area.left}px`;
  els.suggest.style.width = `${form.width}px`;
}

function selectSuggestion(index) {
  selected = index;
  [...els.suggest.children].forEach((row, i) => {
    row.classList.toggle('selected', i === index);
    row.setAttribute('aria-selected', String(i === index));
  });
}

function renderSuggestions(items) {
  suggestions = items;
  if (!items.length) {
    closeSuggestions();
    return;
  }
  els.suggest.replaceChildren(
    ...items.map((item, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'suggestion';
      row.setAttribute('role', 'option');
      const glyph = document.createElement('span');
      glyph.className = 'icon';
      glyph.append(icon(SUGGEST_ICONS[item.type] || 'search'));
      const text = document.createElement('span');
      text.className = 'suggestion-text';
      text.textContent = item.text;
      const detail = document.createElement('span');
      detail.className = 'suggestion-detail';
      detail.textContent = item.detail;
      row.append(glyph, text, detail);
      // mousedown, not click: keep focus in the address bar so the list is not closed by blur first.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        go(item.url);
      });
      row.addEventListener('mousemove', () => {
        if (selected !== index) selectSuggestion(index);
      });
      return row;
    }),
  );
  selectSuggestion(-1);
  placeSuggestions();
  els.suggest.hidden = false;
  els.address.setAttribute('aria-expanded', 'true');
  if (!suggestOpen) {
    suggestOpen = true;
    send('overlay-open');
  }
}

function closeSuggestions({ notify = true } = {}) {
  suggestRequest++;
  clearTimeout(suggestTimer);
  suggestions = [];
  selected = -1;
  els.suggest.hidden = true;
  els.address.setAttribute('aria-expanded', 'false');
  if (!suggestOpen) return;
  suggestOpen = false;
  els.backdrop.hidden = true;
  els.backdrop.removeAttribute('src');
  if (notify) send('overlay-close');
}

function requestSuggestions() {
  clearTimeout(suggestTimer);
  const text = els.address.value.trim();
  if (!text) {
    closeSuggestions();
    return;
  }
  const request = ++suggestRequest;
  suggestTimer = setTimeout(async () => {
    const items = await window.buzz.suggest(text);
    if (request === suggestRequest && document.activeElement === els.address) renderSuggestions(items);
  }, SUGGEST_DELAY_MS);
}

function go(input) {
  if (!input.trim()) return;
  addressEdited = false;
  closeSuggestions();
  send('navigate', input);
}

function resetAddress() {
  addressEdited = false;
  els.address.value = shownUrl || '';
}

els.addressForm.addEventListener('submit', (e) => {
  e.preventDefault();
  go(selected >= 0 ? suggestions[selected].url : els.address.value);
});
els.address.addEventListener('input', () => {
  addressEdited = true;
  requestSuggestions();
});
els.address.addEventListener('focus', () => els.address.select());
els.address.addEventListener('blur', () => {
  closeSuggestions();
  if (addressEdited) resetAddress();
});
els.address.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (suggestOpen) {
      closeSuggestions();
      return;
    }
    resetAddress();
    send('focus-page');
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestions.length) {
    e.preventDefault();
    const count = suggestions.length;
    const next = e.key === 'ArrowDown' ? (selected + 1) % count : (selected - 1 + count) % count;
    selectSuggestion(next);
    const item = suggestions[next];
    els.address.value = item.type === 'search' ? item.text : item.url;
  }
});

window.addEventListener('resize', () => {
  if (suggestOpen) placeSuggestions();
});

// The main process answers 'overlay-open' with a snapshot of the page. Once it
// is on screen the live page view can be hidden without a visible jump.
window.buzz.on('backdrop', async (dataUrl) => {
  if (!suggestOpen) {
    send('overlay-close');
    return;
  }
  if (dataUrl) {
    els.backdrop.src = dataUrl;
    await els.backdrop.decode().catch(() => {});
    if (!suggestOpen) return;
    els.backdrop.hidden = false;
  }
  send('overlay-ready');
});
window.buzz.on('close-suggest', () => closeSuggestions({ notify: false }));

// ---------------------------------------------------------------- shields

function renderShields() {
  const s = state.shields;
  const up = s.adblock && s.siteEnabled;
  els.shields.classList.toggle('down', !up);
  els.toolbarShields.classList.toggle('down', !up);
  els.shieldsState.textContent = up ? 'Up' : 'Down';
  const blocked = number.format(s.blocked);
  for (const el of document.querySelectorAll('[data-blocked]')) el.textContent = blocked;
  els.toolbarShields.title = `Shields ${up ? 'up' : 'down'}: ${blocked} blocked on this page`;

  els.siteSwitchLabel.textContent = s.host ? `Protect ${s.host}` : 'Protect this site';
  els.siteSwitch.disabled = !s.host || !s.adblock;
  els.siteSwitch.setAttribute('aria-checked', String(s.siteEnabled && s.adblock));

  let note = '';
  if (!s.adblock) note = 'Ad blocking is switched off in Settings.';
  else if (s.engine === 'unavailable') note = 'Filter lists could not be downloaded. Buzz will retry.';
  else if (s.engine === 'loading') note = 'Loading filter lists…';
  els.shieldsNote.textContent = note;
  els.shieldsNote.hidden = !note;
  els.shieldsNote.classList.toggle('warn', s.engine === 'unavailable' && s.adblock);
}

function expandSidebar() {
  if (state && state.sidebarCollapsed) send('toggle-sidebar');
}

$('shields-mini').addEventListener('click', expandSidebar);
els.toolbarShields.addEventListener('click', expandSidebar);
els.siteSwitch.addEventListener('click', () => send('toggle-site-shields'));

// ------------------------------------------------------------------- find

function openFind() {
  els.findForm.hidden = false;
  els.findInput.focus();
  els.findInput.select();
  if (els.findInput.value) send('find', { text: els.findInput.value });
}

function closeFind({ refocusPage = true } = {}) {
  if (els.findForm.hidden) return;
  els.findForm.hidden = true;
  els.findCount.textContent = '';
  if (refocusPage) send('stop-find');
}

function findStep(forward) {
  if (els.findInput.value) send('find', { text: els.findInput.value, forward, findNext: true });
}

els.findInput.addEventListener('input', () => {
  if (!els.findInput.value) els.findCount.textContent = '';
  send('find', { text: els.findInput.value });
});
els.findForm.addEventListener('submit', (e) => {
  e.preventDefault();
  findStep(true);
});
els.findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeFind();
  else if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    findStep(false);
  }
});
$('find-prev').addEventListener('click', () => findStep(false));
$('find-next').addEventListener('click', () => findStep(true));
$('find-close').addEventListener('click', () => closeFind());

// ----------------------------------------------------------- main process

window.buzz.on('state', (next) => {
  state = next;
  document.body.classList.toggle('collapsed', state.sidebarCollapsed);
  applyAppearance();
  renderTabs();
  renderToolbar();
  renderShields();
  shownTabId = state.activeTabId;
});
window.buzz.on('toast', showToast);
window.buzz.on('focus-address', () => {
  els.address.focus();
  els.address.select();
});
window.buzz.on('open-find', openFind);
window.buzz.on('close-find', () => closeFind({ refocusPage: false }));
window.buzz.on('find-result', ({ active, total }) => {
  els.findCount.textContent = els.findInput.value ? `${active}/${total}` : '';
});
