'use strict';

(async () => {
  const { h, tool, avatar, hostOf, start, main } = window.App;
  const call = window.buzz.call;
  const PAGE_SIZE = 150;

  const info = await start();
  if (info.isPrivate) {
    main.append(h('div', { class: 'empty' }, h('strong', { text: 'Nothing is recorded here' }), 'Private windows do not keep history.'));
    return;
  }

  const searchBox = h('input', { class: 'field', type: 'search', placeholder: 'Search history', 'aria-label': 'Search history', autofocus: true });
  const list = h('div');
  const more = h('button', { type: 'button', class: 'button more', text: 'Show older', hidden: true, onclick: () => load(false) });
  main.append(
    h('div', { class: 'page-head' }, searchBox, h('a', { class: 'button', href: 'buzz://settings/#privacy', text: 'Clear browsing data' })),
    list,
    more,
  );

  let oldest = 0; // time of the last row shown, for paging
  let currentDay = '';
  let currentCard = null;
  let request = 0;

  const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

  function dayLabel(time) {
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(time))) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return dayFormat.format(time);
  }

  function addVisit(visit) {
    const label = dayLabel(visit.time);
    if (label !== currentDay) {
      currentDay = label;
      currentCard = h('div', { class: 'card' });
      list.append(h('div', { class: 'day', text: label }), currentCard);
    }
    const host = hostOf(visit.url);
    const item = h(
      'div',
      { class: 'item' },
      h('span', { class: 'item-time', text: timeFormat.format(visit.time) }),
      avatar(host),
      h('div', { class: 'item-body' }, h('a', { class: 'item-title', href: visit.url, text: visit.title || visit.url }), h('div', { class: 'item-sub', text: host })),
      h(
        'div',
        { class: 'item-actions' },
        tool('close', 'Remove from history', async () => {
          await call('history-remove', visit.id);
          item.remove();
        }),
      ),
    );
    currentCard.append(item);
  }

  async function load(reset) {
    const id = ++request;
    const text = searchBox.value.trim();
    const visits = await call('history', { text, before: reset ? 0 : oldest, limit: PAGE_SIZE });
    if (id !== request) return;
    if (reset) {
      list.replaceChildren();
      currentDay = '';
    }
    visits.forEach(addVisit);
    if (visits.length) oldest = visits[visits.length - 1].time;
    more.hidden = visits.length < PAGE_SIZE;
    if (reset && !visits.length) {
      list.append(
        h(
          'div',
          { class: 'empty' },
          h('strong', { text: text ? 'No matches' : 'No history yet' }),
          text ? 'Nothing in your history matches that search.' : 'Pages you visit will show up here.',
        ),
      );
    }
  }

  let typing = null;
  searchBox.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => load(true), 140);
  });
  window.buzz.on('history', () => load(true));
  load(true);
})();
