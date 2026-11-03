/*
 * Site updates: the "What's new" card shown after login, and the Site
 * Updates tab's timeline of every change.
 *
 * The update list comes from GET /api/site-updates (config/site-updates.json
 * on the server). The card lists the updates this account hasn't seen yet;
 * closing it records the newest one as seen (POST /api/site-updates/seen),
 * so it doesn't appear again until there is a newer update.
 *
 * The same tab has "Request a feature" and "Report a bug" buttons
 * (POST /api/feedback). Everyone sees their own requests and their status;
 * webmasters see them all and can set the status, reply or delete.
 *
 * Text is always inserted with textContent, never as HTML.
 */
(function () {
  'use strict';

  const MAX_CARD_UPDATES = 3;
  let cache = null;         // last GET /api/site-updates response
  let newIds = new Set();   // updates that were new for this account at login

  const token = () => sessionStorage.getItem('sessionToken');
  const role = () => localStorage.getItem('role') || sessionStorage.getItem('role');
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  function formatDate(iso) {
    const d = new Date(iso + 'T12:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function injectStyles() {
    if (document.getElementById('site-updates-style')) return;
    const st = document.createElement('style');
    st.id = 'site-updates-style';
    st.textContent = `
      .su-card { position: fixed; right: 16px; bottom: 16px; z-index: 3000; width: 380px; max-width: calc(100vw - 32px);
        max-height: 70vh; display: flex; flex-direction: column; background: #fff; color: #1f2937; border-radius: 10px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.28); border-top: 5px solid #2a4d69; font-size: 14px; line-height: 1.45; }
      .su-card-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 6px; }
      .su-card-head h3 { margin: 0; font-size: 17px; color: #2a4d69; flex: 1; }
      .su-card button.su-x { background: transparent; color: #475569; border: none; padding: 2px 8px; font-size: 22px; line-height: 1;
        font-weight: 400; cursor: pointer; border-radius: 4px; }
      .su-card button.su-x:hover { background: #f1f5f9; color: #0f172a; }
      .su-card-body { overflow-y: auto; padding: 0 14px 4px; }
      .su-card-foot { display: flex; gap: 8px; justify-content: flex-end; padding: 10px 14px 12px; border-top: 1px solid #e5e7eb; flex-wrap: wrap; }
      .su-card button.su-secondary { background: #fff; color: #2a4d69; border: 1px solid #2a4d69; }
      .su-card button.su-secondary:hover { background: #eef4f9; }
      .su-entry { margin: 8px 0 12px; }
      .su-date { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.03em; }
      .su-title { font-weight: 700; margin: 1px 0 3px; color: #0f172a; }
      .su-entry ul { margin: 0; padding-left: 20px; }
      .su-entry li { margin: 2px 0; }
      .su-visibility { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: #64748b; cursor: pointer; user-select: none; }
      .su-visibility input { margin: 0; }
      .su-visibility-status { color: #166534; }
      .su-more { color: #64748b; font-style: italic; margin: 0 0 6px; }
      .su-timeline { position: relative; max-width: 820px; margin: 10px 0 20px; padding-left: 26px; }
      .su-timeline::before { content: ''; position: absolute; left: 8px; top: 6px; bottom: 6px; width: 2px; background: #cbd5e1; }
      .su-timeline .su-entry { position: relative; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; margin: 0 0 14px; }
      .su-timeline .su-entry::before { content: ''; position: absolute; left: -24px; top: 14px; width: 12px; height: 12px; border-radius: 50%;
        background: #4b86b4; border: 2px solid #fff; box-shadow: 0 0 0 2px #4b86b4; }
      .su-badge { display: inline-block; margin-left: 8px; padding: 0 7px; border-radius: 10px; background: #dcfce7; color: #166534;
        font-size: 11px; font-weight: 700; vertical-align: middle; text-transform: none; letter-spacing: 0; }
      .fb-bar { display: flex; gap: 10px; flex-wrap: wrap; margin: 6px 0 12px; }
      .fb-bar button { display: inline-flex; align-items: center; gap: 6px; }
      .fb-bar button.fb-bug { background: #b45309; }
      .fb-bar button.fb-bug:hover { background: #92400e; }
      .fb-form { max-width: 820px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px 14px; margin: 0 0 14px; }
      .fb-form h4 { margin: 0 0 8px; }
      .fb-form label { display: block; font-weight: 600; margin: 8px 0 3px; }
      .fb-form input[type=text], .fb-form textarea { width: 100%; box-sizing: border-box; padding: 7px 8px; border: 1px solid #94a3b8; border-radius: 4px; font: inherit; }
      .fb-form textarea { min-height: 110px; resize: vertical; }
      .fb-hint { color: #64748b; font-size: 12px; margin-top: 3px; }
      .fb-actions { display: flex; gap: 8px; margin-top: 10px; align-items: center; flex-wrap: wrap; }
      .fb-actions button.fb-cancel, .fb-item button.fb-plain { background: #fff; color: #2a4d69; border: 1px solid #2a4d69; }
      .fb-msg { margin: 0 0 12px; padding: 8px 12px; border-radius: 6px; max-width: 820px; }
      .fb-msg.ok { background: #dcfce7; color: #166534; }
      .fb-msg.err { background: #fee2e2; color: #991b1b; }
      .fb-list { max-width: 820px; margin: 4px 0 18px; }
      .fb-list > summary { cursor: pointer; font-weight: 700; color: #2a4d69; margin-bottom: 8px; }
      .fb-filters { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 8px; }
      .fb-item { background: #fff; border: 1px solid #e5e7eb; border-left: 4px solid #4b86b4; border-radius: 6px; padding: 8px 12px; margin: 0 0 8px; }
      .fb-item.bug { border-left-color: #b45309; }
      .fb-meta { font-size: 12px; color: #64748b; }
      .fb-item-title { font-weight: 700; margin: 2px 0; }
      .fb-desc { white-space: pre-wrap; margin: 2px 0 4px; }
      .fb-status { display: inline-block; padding: 0 8px; border-radius: 10px; font-size: 11px; font-weight: 700; background: #e2e8f0; color: #334155; margin-left: 6px; }
      .fb-status.new { background: #dbeafe; color: #1e40af; } .fb-status.planned { background: #ede9fe; color: #5b21b6; }
      .fb-status.in-progress { background: #fef3c7; color: #92400e; } .fb-status.done { background: #dcfce7; color: #166534; }
      .fb-status.declined { background: #f1f5f9; color: #475569; }
      .fb-reply { background: #eef4f9; border-radius: 4px; padding: 5px 8px; margin: 4px 0; white-space: pre-wrap; }
      .fb-manage { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start; margin-top: 6px; }
      .fb-manage textarea { flex: 1 1 260px; min-height: 40px; padding: 5px 7px; border: 1px solid #94a3b8; border-radius: 4px; font: inherit; }
      .fb-manage button { padding: 6px 12px; }
      .fb-manage button.fb-del { background: #b91c1c; }
      @media (max-width: 600px) { .su-card { right: 8px; left: 8px; bottom: 8px; width: auto; max-width: none; } }
    `;
    document.head.appendChild(st);
  }

  function entryEl(u, isNew, showVisibilityControl) {
    const box = el('div', 'su-entry');
    const date = el('div', 'su-date', formatDate(u.date));
    if (isNew) date.appendChild(el('span', 'su-badge', 'New'));
    box.appendChild(date);
    box.appendChild(el('div', 'su-title', u.title));
    if (u.changes.length) {
      const ul = el('ul');
      u.changes.forEach(c => ul.appendChild(el('li', null, c)));
      box.appendChild(ul);
    }
    // Webmaster-only, and only on the full Site Updates tab (not the brief
    // "What's new" popup card) - a checkbox to hide this entry from
    // everyone else (member and admin alike) without editing
    // config/site-updates.json by hand. GET /api/site-updates already
    // sends a webmaster every entry (that's the only way this checkbox can
    // reflect the real state), so this never shows for anyone who wouldn't
    // also already see the entry.
    if (showVisibilityControl && role() === 'webmaster') box.appendChild(visibilityRow(u));
    return box;
  }

  function visibilityRow(u) {
    const row = el('label', 'su-visibility');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!u.webmasterOnly;
    const status = el('span', 'su-visibility-status');
    row.appendChild(cb);
    row.appendChild(document.createTextNode(' Hide from everyone but webmasters'));
    row.appendChild(status);
    cb.addEventListener('change', async () => {
      const next = cb.checked;
      cb.disabled = true;
      status.textContent = ' Saving…';
      try {
        await api('POST', '/api/site-updates/visibility', { id: u.id, webmasterOnly: next });
        u.webmasterOnly = next;
        if (cache) {
          const cached = (cache.updates || []).find(x => x.id === u.id);
          if (cached) cached.webmasterOnly = next;
        }
        status.textContent = ' Saved';
        setTimeout(() => { status.textContent = ''; }, 1500);
      } catch (err) {
        cb.checked = !next;
        status.textContent = ' Error: ' + err.message;
      } finally {
        cb.disabled = false;
      }
    });
    return row;
  }

  async function fetchUpdates() {
    const t = token();
    if (!t) return null;
    const res = await fetch('/api/site-updates', { headers: { Authorization: 'Bearer ' + t } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    cache = await res.json();
    return cache;
  }

  // The updates this account hasn't seen: everything newer than the one it
  // last dismissed. An account that has never dismissed the card is shown
  // just the latest update rather than the whole history.
  function unseenOf(data) {
    const list = data.updates || [];
    if (!list.length) return [];
    if (data.lastSeenUpdateId) {
      const k = list.findIndex(u => u.id === data.lastSeenUpdateId);
      if (k >= 0) return list.slice(0, k);
    }
    if (data.lastSeenUpdateDate) return list.filter(u => u.date > data.lastSeenUpdateDate);
    return list.slice(0, 1);
  }

  function markSeen(id) {
    const t = token();
    if (!t || !id) return;
    fetch('/api/site-updates/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ id })
    }).then(() => { if (cache) cache.lastSeenUpdateId = id; }).catch(err => console.warn('Could not save the seen update:', err));
  }

  function hide() {
    const card = document.getElementById('site-updates-card');
    if (card) card.remove();
  }

  function showCard(unseen, newestId) {
    hide();
    injectStyles();
    const card = el('div', 'su-card');
    card.id = 'site-updates-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-labelledby', 'site-updates-card-title');

    const head = el('div', 'su-card-head');
    const h = el('h3', null, "What's new");
    h.id = 'site-updates-card-title';
    const x = el('button', 'su-x', '×');
    x.type = 'button'; x.title = 'Close'; x.setAttribute('aria-label', 'Close');
    head.appendChild(h); head.appendChild(x);

    const body = el('div', 'su-card-body');
    unseen.slice(0, MAX_CARD_UPDATES).forEach(u => body.appendChild(entryEl(u, false)));
    if (unseen.length > MAX_CARD_UPDATES) {
      const n = unseen.length - MAX_CARD_UPDATES;
      body.appendChild(el('p', 'su-more', `…and ${n} earlier update${n === 1 ? '' : 's'}. See them all on the Site Updates tab.`));
    }

    const foot = el('div', 'su-card-foot');
    const all = el('button', 'su-secondary', 'See all updates');
    all.type = 'button';
    const ok = el('button', null, 'Got it');
    ok.type = 'button';
    foot.appendChild(all); foot.appendChild(ok);

    card.appendChild(head); card.appendChild(body); card.appendChild(foot);
    document.body.appendChild(card);

    const close = () => { hide(); markSeen(newestId); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape' && document.getElementById('site-updates-card') && !document.querySelector('.terrain3d-overlay')) close(); };
    x.addEventListener('click', close);
    ok.addEventListener('click', close);
    all.addEventListener('click', () => {
      close();
      const tab = document.querySelector('.tab[data-tab="site-updates"]');
      if (tab) { tab.click(); tab.scrollIntoView({ block: 'nearest' }); }
    });
    document.addEventListener('keydown', onKey);
    ok.focus({ preventScroll: true });
  }

  // After login: show the card if there is anything this account hasn't seen
  async function checkAfterLogin() {
    hide();
    try {
      const data = await fetchUpdates();
      if (!data || !data.updates || !data.updates.length) return;
      const unseen = unseenOf(data);
      newIds = new Set(unseen.map(u => u.id));
      renderTimeline(); // keep the tab current if it's already open
      if (unseen.length) showCard(unseen, data.updates[0].id);
    } catch (err) {
      console.warn('Could not load site updates:', err);
    }
  }

  // Fill the Site Updates tab with the full timeline, newest first
  async function renderTimeline() {
    const box = document.getElementById('site-updates-list');
    if (!box) return;
    injectStyles();
    try {
      const data = cache || await fetchUpdates();
      box.textContent = '';
      const list = (data && data.updates) || [];
      if (!list.length) { box.appendChild(el('p', null, 'No updates have been posted yet.')); return; }
      const tl = el('div', 'su-timeline');
      list.forEach(u => tl.appendChild(entryEl(u, newIds.has(u.id), true)));
      box.appendChild(tl);
    } catch (err) {
      box.textContent = 'Could not load the update history. Please try again later.';
    }
  }

  // ---------- Feature requests and bug reports ----------
  const STATUS_LABELS = { new: 'New', planned: 'Planned', 'in-progress': 'In progress', done: 'Done', declined: "Won't do" };
  const TYPE_LABELS = { feature: 'Feature request', bug: 'Bug report' };

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + token() }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }
  const btn = (label, cls) => { const b = el('button', cls, label); b.type = 'button'; return b; };
  function when(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  let fbState = { type: 'all', status: 'open', expanded: null }; // list filters + whether the list is open

  async function renderFeedback(message) {
    const root = document.getElementById('feedback-section');
    if (!root || !token()) return;
    injectStyles();
    root.textContent = '';

    const bar = el('div', 'fb-bar');
    const reqBtn = btn('💡 Request a feature', 'fb-feature');
    const bugBtn = btn('🐞 Report a bug', 'fb-bug');
    bar.appendChild(reqBtn); bar.appendChild(bugBtn);
    root.appendChild(bar);
    if (message) root.appendChild(el('div', 'fb-msg ' + message.kind, message.text));
    const formSlot = el('div');
    root.appendChild(formSlot);
    reqBtn.addEventListener('click', () => showForm(formSlot, 'feature'));
    bugBtn.addEventListener('click', () => showForm(formSlot, 'bug'));

    const listSlot = el('div');
    root.appendChild(listSlot);
    try {
      const data = await api('GET', '/api/feedback');
      renderFeedbackList(listSlot, data.items || [], !!data.canManage);
    } catch (err) {
      listSlot.appendChild(el('p', 'fb-hint', 'Could not load requests and reports: ' + err.message));
    }
  }

  function showForm(slot, type) {
    slot.textContent = '';
    const isBug = type === 'bug';
    const form = el('form', 'fb-form');
    form.appendChild(el('h4', null, isBug ? 'Report a bug' : 'Request a feature'));
    form.appendChild(el('label', null, isBug ? 'What went wrong? (short title)' : 'What would you like? (short title)'));
    const title = el('input'); title.type = 'text'; title.maxLength = 150; title.required = true;
    title.placeholder = isBug ? 'e.g. Map markers disappear after filtering' : 'e.g. Export the map view as a PDF';
    form.appendChild(title);
    form.appendChild(el('label', null, 'Details'));
    const desc = el('textarea'); desc.maxLength = 5000; desc.required = true;
    desc.placeholder = isBug
      ? 'What were you doing, what happened, and what did you expect to happen? Which tab or page, and on what device?'
      : 'Describe the feature and how it would help you.';
    form.appendChild(desc);
    form.appendChild(el('div', 'fb-hint', isBug
      ? 'Your browser and device type are included automatically to help track it down.'
      : 'The webmasters will see this and can reply here.'));
    const actions = el('div', 'fb-actions');
    const send = el('button', null, isBug ? 'Send bug report' : 'Send request'); send.type = 'submit';
    const cancel = btn('Cancel', 'fb-cancel');
    const status = el('span', 'fb-hint');
    actions.appendChild(send); actions.appendChild(cancel); actions.appendChild(status);
    form.appendChild(actions);
    slot.appendChild(form);
    title.focus();

    cancel.addEventListener('click', () => { slot.textContent = ''; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!title.value.trim() || !desc.value.trim()) { status.textContent = 'Please fill in both boxes.'; return; }
      send.disabled = true; status.textContent = 'Sending…';
      try {
        await api('POST', '/api/feedback', { type, title: title.value, description: desc.value });
        renderFeedback({ kind: 'ok', text: isBug ? 'Thanks! Your bug report was sent to the webmasters.' : 'Thanks! Your feature request was sent to the webmasters.' });
      } catch (err) {
        send.disabled = false; status.textContent = '';
        slot.insertBefore(el('div', 'fb-msg err', 'Could not send: ' + err.message), form);
      }
    });
  }

  function itemEl(f, canManage, rerender) {
    const box = el('div', 'fb-item' + (f.type === 'bug' ? ' bug' : ''));
    const meta = el('div', 'fb-meta', `${TYPE_LABELS[f.type] || f.type} · ${when(f.created)}${canManage ? ' · from ' + f.submittedBy : ''}`);
    meta.appendChild(el('span', 'fb-status ' + f.status, STATUS_LABELS[f.status] || f.status));
    box.appendChild(meta);
    box.appendChild(el('div', 'fb-item-title', f.title));
    box.appendChild(el('div', 'fb-desc', f.description));
    if (canManage && f.userAgent) box.appendChild(el('div', 'fb-meta', 'Browser: ' + f.userAgent));
    if (f.response && !canManage) box.appendChild(el('div', 'fb-reply', 'Webmaster reply: ' + f.response));
    if (canManage) {
      const row = el('div', 'fb-manage');
      const sel = el('select');
      Object.keys(STATUS_LABELS).forEach(k => { const o = el('option', null, STATUS_LABELS[k]); o.value = k; sel.appendChild(o); });
      sel.value = f.status;
      const reply = el('textarea'); reply.maxLength = 2000; reply.value = f.response || '';
      reply.placeholder = 'Reply (shown to the person who sent it)';
      const save = btn('Save');
      const del = btn('Delete', 'fb-del');
      const note = el('span', 'fb-hint');
      row.appendChild(sel); row.appendChild(reply); row.appendChild(save); row.appendChild(del); row.appendChild(note);
      box.appendChild(row);
      save.addEventListener('click', async () => {
        save.disabled = true; note.textContent = 'Saving…';
        try { Object.assign(f, (await api('PATCH', '/api/feedback/' + encodeURIComponent(f.id), { status: sel.value, response: reply.value })).item); rerender(); }
        catch (err) { note.textContent = 'Could not save: ' + err.message; save.disabled = false; }
      });
      del.addEventListener('click', async () => {
        if (!confirm('Delete "' + f.title + '"? This cannot be undone.')) return;
        try { await api('DELETE', '/api/feedback/' + encodeURIComponent(f.id)); f._deleted = true; rerender(); }
        catch (err) { note.textContent = 'Could not delete: ' + err.message; }
      });
    }
    return box;
  }

  function renderFeedbackList(slot, items, canManage) {
    const draw = () => {
      slot.textContent = '';
      const live = items.filter(f => !f._deleted);
      if (!canManage) {
        if (!live.length) return;
        const det = el('details', 'fb-list');
        det.open = !!fbState.expanded;
        det.addEventListener('toggle', () => { fbState.expanded = det.open; });
        det.appendChild(el('summary', null, `Your requests and reports (${live.length})`));
        live.forEach(f => det.appendChild(itemEl(f, false, draw)));
        slot.appendChild(det);
        return;
      }
      const open = live.filter(f => f.status !== 'done' && f.status !== 'declined').length;
      const det = el('details', 'fb-list');
      // Opens by itself when something new is waiting; after that it stays
      // however the webmaster left it
      det.open = fbState.expanded == null ? live.some(f => f.status === 'new') : fbState.expanded;
      det.addEventListener('toggle', () => { fbState.expanded = det.open; });
      det.appendChild(el('summary', null, `Feature requests & bug reports (${open} open, ${live.length} total)`));
      const filters = el('div', 'fb-filters');
      const typeSel = el('select'), statusSel = el('select');
      [['all', 'All types'], ['feature', 'Feature requests'], ['bug', 'Bug reports']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; typeSel.appendChild(o); });
      [['open', 'Open'], ['all', 'Any status']].concat(Object.entries(STATUS_LABELS)).forEach(([v, t]) => { const o = el('option', null, t); o.value = v; statusSel.appendChild(o); });
      typeSel.value = fbState.type; statusSel.value = fbState.status;
      typeSel.addEventListener('change', () => { fbState.type = typeSel.value; draw(); });
      statusSel.addEventListener('change', () => { fbState.status = statusSel.value; draw(); });
      filters.appendChild(typeSel); filters.appendChild(statusSel);
      det.appendChild(filters);
      const shown = live.filter(f => (fbState.type === 'all' || f.type === fbState.type) &&
        (fbState.status === 'all' || (fbState.status === 'open' ? f.status !== 'done' && f.status !== 'declined' : f.status === fbState.status)));
      if (!shown.length) det.appendChild(el('p', 'fb-hint', live.length ? 'Nothing matches these filters.' : 'No requests or reports yet.'));
      shown.forEach(f => det.appendChild(itemEl(f, true, draw)));
      slot.appendChild(det);
    };
    draw();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const tab = document.querySelector('.tab[data-tab="site-updates"]');
    if (tab) tab.addEventListener('click', () => { cache = null; renderTimeline(); renderFeedback(); });
  });

  window.SiteUpdates = { checkAfterLogin, renderTimeline, renderFeedback, hide };
})();
