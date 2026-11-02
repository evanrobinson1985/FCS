/*
 * Site updates: the "What's new" card shown after login, and the Site
 * Updates tab's timeline of every change.
 *
 * The update list comes from GET /api/site-updates (config/site-updates.json
 * on the server). The card lists the updates this account hasn't seen yet;
 * closing it records the newest one as seen (POST /api/site-updates/seen),
 * so it doesn't appear again until there is a newer update.
 *
 * Text is always inserted with textContent, never as HTML.
 */
(function () {
  'use strict';

  const MAX_CARD_UPDATES = 3;
  let cache = null;         // last GET /api/site-updates response
  let newIds = new Set();   // updates that were new for this account at login

  const token = () => sessionStorage.getItem('sessionToken');
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
      .su-more { color: #64748b; font-style: italic; margin: 0 0 6px; }
      .su-timeline { position: relative; max-width: 820px; margin: 10px 0 20px; padding-left: 26px; }
      .su-timeline::before { content: ''; position: absolute; left: 8px; top: 6px; bottom: 6px; width: 2px; background: #cbd5e1; }
      .su-timeline .su-entry { position: relative; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; margin: 0 0 14px; }
      .su-timeline .su-entry::before { content: ''; position: absolute; left: -24px; top: 14px; width: 12px; height: 12px; border-radius: 50%;
        background: #4b86b4; border: 2px solid #fff; box-shadow: 0 0 0 2px #4b86b4; }
      .su-badge { display: inline-block; margin-left: 8px; padding: 0 7px; border-radius: 10px; background: #dcfce7; color: #166534;
        font-size: 11px; font-weight: 700; vertical-align: middle; text-transform: none; letter-spacing: 0; }
      @media (max-width: 600px) { .su-card { right: 8px; left: 8px; bottom: 8px; width: auto; max-width: none; } }
    `;
    document.head.appendChild(st);
  }

  function entryEl(u, isNew) {
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
    return box;
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
      list.forEach(u => tl.appendChild(entryEl(u, newIds.has(u.id))));
      box.appendChild(tl);
    } catch (err) {
      box.textContent = 'Could not load the update history. Please try again later.';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const tab = document.querySelector('.tab[data-tab="site-updates"]');
    if (tab) tab.addEventListener('click', () => { cache = null; renderTimeline(); });
  });

  window.SiteUpdates = { checkAfterLogin, renderTimeline, hide };
})();
