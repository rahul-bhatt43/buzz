'use strict';

(async () => {
  const { h, icon, tool, hostOf, formatBytes, start, main } = window.App;
  const call = window.buzz.call;

  await start();

  const list = h('div');
  main.append(
    h(
      'div',
      { class: 'page-head' },
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'button', text: 'Clear list', onclick: () => call('downloads-clear') }),
    ),
    list,
  );

  const act = (id, action) => () => call('download-action', id, action);
  const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function status(d) {
    const from = hostOf(d.url);
    switch (d.state) {
      case 'progressing':
        return d.total ? `${formatBytes(d.received)} of ${formatBytes(d.total)} from ${from}` : `${formatBytes(d.received)} from ${from}`;
      case 'paused':
        return `Paused at ${formatBytes(d.received)}`;
      case 'completed':
        return `${formatBytes(d.total)} from ${from}, ${dateFormat.format(d.ended || d.started)}`;
      case 'cancelled':
        return 'Cancelled';
      default:
        return 'Failed. The download was interrupted.';
    }
  }

  function row(d) {
    const running = d.state === 'progressing' || d.state === 'paused';
    const done = d.state === 'completed';
    const title = done
      ? h('button', { type: 'button', class: 'item-title', text: d.filename, title: 'Open file', onclick: act(d.id, 'open') })
      : h('span', { class: 'item-title', text: d.filename });
    const percent = d.total ? Math.min(100, (d.received / d.total) * 100) : 0;
    const bar = h('span');
    bar.style.width = `${percent}%`;
    const sub = h('div', { class: `item-sub${!running && !done ? ' failed' : ''}`, text: status(d) });
    const el = h(
      'div',
      { class: 'item' },
      h('span', { class: 'file-icon' }, icon(done ? 'file' : running ? 'downloads' : 'warning')),
      h('div', { class: 'item-body' }, title, sub, running ? h('div', { class: 'bar' }, bar) : null),
      h(
        'div',
        { class: 'item-actions' },
        d.state === 'progressing' ? tool('pause', 'Pause', act(d.id, 'pause')) : null,
        d.state === 'paused' ? tool('play', 'Resume', act(d.id, 'resume')) : null,
        running ? tool('close', 'Cancel', act(d.id, 'cancel')) : null,
        d.path ? tool('folder', 'Show in folder', act(d.id, 'show')) : null,
        !running ? tool('trash', 'Remove from list', act(d.id, 'remove')) : null,
      ),
    );
    return { el, sub, bar, state: d.state, filename: d.filename };
  }

  const rows = new Map(); // download id -> rendered row
  const card = h('div', { class: 'card' });
  const wrap = h('div', { class: 'section', hidden: true }, card);
  const empty = h('div', { class: 'empty', hidden: true }, h('strong', { text: 'No downloads yet' }), 'Files you download will show up here.');
  list.append(wrap, empty);

  // Progress arrives several times a second, so rows are updated in place and
  // only rebuilt when a download changes state (which changes its buttons).
  async function render() {
    const downloads = await call('downloads');
    const seen = new Set();
    let previous = null;
    for (const d of downloads) {
      seen.add(d.id);
      let current = rows.get(d.id);
      if (current && current.state === d.state && current.filename === d.filename) {
        current.sub.textContent = status(d);
        current.bar.style.width = `${d.total ? Math.min(100, (d.received / d.total) * 100) : 0}%`;
      } else {
        const next = row(d);
        if (current) current.el.replaceWith(next.el);
        rows.set(d.id, next);
        current = next;
      }
      const expected = previous ? previous.nextSibling : card.firstChild;
      if (expected !== current.el) card.insertBefore(current.el, expected);
      previous = current.el;
    }
    for (const [id, current] of rows) {
      if (!seen.has(id)) {
        current.el.remove();
        rows.delete(id);
      }
    }
    wrap.hidden = downloads.length === 0;
    empty.hidden = downloads.length > 0;
  }

  window.buzz.on('downloads', render);
  render();
})();
