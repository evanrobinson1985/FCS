/*
 * Membership dues, in the browser:
 * - each member's own status line by "Logged in as" (+ Pay dues button);
 * - the expired-membership screen, only when the webmaster has turned the
 *   dues access switch on (Account Management; off by default);
 * - the Dues column in Account Management (record a payment, payment
 *   history, "Send dues email" for expired members);
 * - the Membership Dues card in Account Management (webmasters);
 * - the Treasurer's view of Account Management (members, dues, and
 *   setting member accounts active/inactive), and the webmaster's
 *   Treasurer checkbox in the user table.
 *
 * Server side: lib/dues.js and the /api/dues, /api/my-membership and
 * /api/users/:username/dues routes in server.js. Text is inserted with
 * textContent, or escaped, never as raw HTML.
 */
(function () {
  'use strict';

  const token = () => sessionStorage.getItem('sessionToken');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const money = (n) => '$' + Number(n || 0).toFixed(2);
  const METHOD_LABELS = { paypal: 'PayPal', cash: 'Cash', check: 'Check', other: 'Other' };

  function fmtDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  function fmtWhen(isoTime) {
    const d = new Date(isoTime);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function todayEastern() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + token() }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) { const e = new Error(data.error || ('HTTP ' + res.status)); e.data = data; throw e; }
    return data;
  }

  function injectStyles() {
    if (document.getElementById('membership-style')) return;
    const st = document.createElement('style');
    st.id = 'membership-style';
    st.textContent = `
      #membership-status { display: inline-block; margin-left: 12px; font-size: 0.9em; padding: 2px 8px; border-radius: 10px; }
      #membership-status.paid { background: #dcfce7; color: #166534; }
      #membership-status.due-soon { background: #fef3c7; color: #92400e; }
      #membership-status.expired { background: #fee2e2; color: #991b1b; }
      #membership-status.none { background: #f1f5f9; color: #475569; }
      #membership-status a.ms-pay { margin-left: 6px; font-weight: 700; color: inherit; }
      .dues-cell { min-width: 200px; font-size: 0.9em; }
      .name-cell { min-width: 120px; }
      .name-cell button.name-edit { padding: 2px 8px; font-size: 0.8em; margin-top: 3px; width: auto; background: #fff; color: #2a4d69; border: 1px solid #2a4d69; }
      .dues-state { font-weight: 700; }
      .dues-state.paid { color: #166534; } .dues-state.due-soon { color: #b45309; }
      .dues-state.expired { color: #b91c1c; } .dues-state.none { color: #64748b; font-weight: 400; font-style: italic; }
      .dues-sub { color: #64748b; font-size: 0.85em; }
      #dues-settings-section > details > summary { font-weight: bold; font-size: 1.08em; cursor: pointer; margin-bottom: 4px; }
      #dues-settings-section > details > summary::marker { color: #2a4d69; }
      .dues-cell .dues-btns { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
      .dues-cell button { padding: 3px 8px; font-size: 0.8em; white-space: nowrap; width: auto; }
      .dues-cell button.dues-notice { background: #b91c1c; }
      .dues-cell button.dues-plain { background: #fff; color: #2a4d69; border: 1px solid #2a4d69; }
      .dues-modal-back { position: fixed; inset: 0; z-index: 4000; background: rgba(15,23,42,0.45); display: flex; align-items: center; justify-content: center; padding: 16px; }
      .dues-modal { background: #fff; color: #1f2937; border-radius: 10px; width: 440px; max-width: 100%; max-height: 90vh; overflow-y: auto; padding: 16px 18px; box-shadow: 0 10px 40px rgba(0,0,0,0.3); }
      .dues-modal h4 { margin: 0 0 4px; }
      .dues-modal label { display: block; font-weight: 600; margin: 10px 0 3px; }
      .dues-modal input, .dues-modal select { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #94a3b8; border-radius: 4px; font: inherit; }
      .dues-modal .dm-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; flex-wrap: wrap; }
      .dues-modal button.dm-cancel { background: #fff; color: #2a4d69; border: 1px solid #2a4d69; }
      .dues-modal .dm-err { color: #b91c1c; margin-top: 8px; }
      .dues-modal .dm-hint { color: #64748b; font-size: 0.85em; margin-top: 3px; }
      .dues-modal table { width: 100%; border-collapse: collapse; font-size: 0.9em; margin-top: 8px; }
      .dues-modal td, .dues-modal th { text-align: left; padding: 5px 4px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
      .dues-modal td button { padding: 2px 8px; font-size: 0.8em; background: #b91c1c; }
      #treasurer-view .tv-bar { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 12px; }
      #treasurer-view .tv-bar input { flex: 1 1 220px; padding: 7px 8px; border: 1px solid #94a3b8; border-radius: 4px; }
      #treasurer-view .tv-bar select { padding: 6px; }
      #treasurer-view table { width: 100%; border-collapse: collapse; background: #fff; }
      #treasurer-view th { background: #4b86b4; color: #fff; text-align: left; padding: 8px; font-size: 0.9em; }
      #treasurer-view td { padding: 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
      #treasurer-view .tv-wrap { overflow-x: auto; }
      #treasurer-view .tv-status { font-weight: 600; }
      #treasurer-view .tv-status.active { color: #166534; } #treasurer-view .tv-status.pending { color: #b45309; }
      #treasurer-view .tv-status.inactive { color: #b91c1c; }
      #treasurer-view td button.tv-act { padding: 3px 8px; font-size: 0.8em; margin-top: 4px; white-space: nowrap; width: auto; }
      #treasurer-view td button.tv-act.deactivate { background: #fff; color: #b91c1c; border: 1px solid #b91c1c; }
      #treasurer-view .tv-price { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 4px 0 12px; padding: 10px 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; }
      #treasurer-view .tv-price label { font-weight: 600; }
      #treasurer-view .tv-price input { width: 100px; padding: 5px 7px; border: 1px solid #94a3b8; border-radius: 4px; }
      #treasurer-view .tv-price button { padding: 5px 12px; width: auto; }
      #treasurer-view .tv-summary { color: #475569; margin: 0 0 6px; }
      #membership-block { max-width: 640px; margin: 40px auto; padding: 28px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; text-align: center; }
      #membership-block a.ms-pay-big { display: inline-block; margin-top: 10px; padding: 9px 20px; border-radius: 18px; background: #2a4d69; color: #fff; text-decoration: none; font-weight: 700; }
    `;
    document.head.appendChild(st);
  }

  // ---------- the member's own status ----------
  let mine = null;

  function statusText(s) {
    if (s.state === 'paid' || s.state === 'due-soon') return `Membership paid through ${fmtDate(s.expires)} · ${plural(s.daysLeft, 'day')} left`;
    if (s.state === 'expired') return `Membership expired ${fmtDate(s.expires)}`;
    return 'Membership: contact a webmaster to confirm your dues';
  }

  function renderMine() {
    let span = document.getElementById('membership-status');
    if (!mine || mine.state === 'exempt') { if (span) span.remove(); return; }
    injectStyles();
    if (!span) {
      span = el('span');
      span.id = 'membership-status';
      const anchor = document.getElementById('logged-in-user');
      if (!anchor || !anchor.parentNode) return;
      anchor.parentNode.insertBefore(span, anchor.nextSibling);
    }
    span.className = mine.state;
    span.textContent = statusText(mine);
    if ((mine.state === 'due-soon' || mine.state === 'expired') && mine.payLink) {
      const a = el('a', 'ms-pay', `Pay dues (${money(mine.duesAmount)})`);
      a.href = mine.payLink; a.target = '_blank'; a.rel = 'noopener noreferrer';
      span.appendChild(a);
    }
  }

  function showBlock() {
    injectStyles();
    const tabs = document.querySelector('.tab-container');
    if (tabs) tabs.style.display = 'none';
    let box = document.getElementById('membership-block');
    if (!box) {
      box = el('div');
      box.id = 'membership-block';
      const dash = document.getElementById('dashboard');
      if (dash) dash.appendChild(box);
    }
    box.textContent = '';
    box.appendChild(el('h3', null, 'Your membership has expired'));
    box.appendChild(el('p', null, `Your Florida Cave Survey membership expired on ${fmtDate(mine.expires)}. Please pay your yearly dues of ${money(mine.duesAmount)} to regain access to the site.`));
    if (mine.payLink) {
      const a = el('a', 'ms-pay-big', `Pay dues with PayPal (${money(mine.duesAmount)})`);
      a.href = mine.payLink; a.target = '_blank'; a.rel = 'noopener noreferrer';
      box.appendChild(a);
    }
    box.appendChild(el('p', 'dues-sub', "Already paid? It can take a little while for a webmaster to record it. Log out and back in once they have."));
  }

  function hide() {
    const span = document.getElementById('membership-status');
    if (span) span.remove();
    const box = document.getElementById('membership-block');
    if (box) {
      box.remove();
      const tabs = document.querySelector('.tab-container');
      if (tabs) tabs.style.display = '';
    }
    mine = null;
  }

  async function afterLogin() {
    hide();
    try {
      mine = await api('GET', '/api/my-membership');
      renderMine();
      if (mine.enforcement && mine.state === 'expired') showBlock();
    } catch (err) {
      console.warn('Could not load membership status:', err);
    }
  }

  // ---------- Account Management: Dues column ----------
  const duesByUser = new Map(); // username -> dues view from the server

  function duesCellHtml(user) {
    injectStyles();
    const d = user.dues;
    if (!d || d.state === 'exempt') return '<em style="color:#888;">Exempt</em>';
    duesByUser.set(user.username, d);
    const u = esc(user.username);
    let main, sub = '';
    if (d.state === 'paid') { main = `<div class="dues-state paid">Paid</div>`; sub = `through ${esc(fmtDate(d.expires))} (${plural(d.daysLeft, 'day')} left)`; }
    else if (d.state === 'due-soon') { main = `<div class="dues-state due-soon">Due soon</div>`; sub = `expires ${esc(fmtDate(d.expires))} (${plural(d.daysLeft, 'day')} left)`; }
    else if (d.state === 'expired') { main = `<div class="dues-state expired">Expired</div>`; sub = `on ${esc(fmtDate(d.expires))}`; }
    else { main = `<div class="dues-state none">No payment recorded</div>`; }
    const sent = [];
    if (d.reminderSentAt) sent.push(`reminder sent ${esc(fmtWhen(d.reminderSentAt))}`);
    if (d.noticeSentAt) sent.push(`dues email sent ${esc(fmtWhen(d.noticeSentAt))}`);
    return `<div class="dues-cell" data-dues-user="${u}">
      ${main}${sub ? `<div class="dues-sub">${sub}</div>` : ''}${sent.length ? `<div class="dues-sub">${sent.join(' · ')}</div>` : ''}
      <div class="dues-btns">
        ${d.state === 'expired' ? `<button type="button" class="dues-notice" data-dues-action="notice" data-username="${u}">Send dues email</button>` : ''}
        <button type="button" data-dues-action="record" data-username="${u}">Record payment</button>
        ${(d.payments || []).length ? `<button type="button" class="dues-plain" data-dues-action="history" data-username="${u}">History (${d.payments.length})</button>` : ''}
      </div></div>`;
  }

  function refreshCell(username, d) {
    const cell = [...document.querySelectorAll('[data-dues-user]')].find(c => c.dataset.duesUser === username);
    if (!cell) return;
    cell.outerHTML = duesCellHtml({ username, dues: d });
  }

  function modal(title) {
    injectStyles();
    const back = el('div', 'dues-modal-back');
    const box = el('div', 'dues-modal');
    box.setAttribute('role', 'dialog');
    box.appendChild(el('h4', null, title));
    back.appendChild(box);
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    return { box, close };
  }

  function recordPayment(username) {
    const { box, close } = modal('Record a dues payment');
    box.appendChild(el('div', 'dm-hint', `For ${username}. Membership runs one year from the payment; paying early adds the year onto the current expiry date.`));
    const form = el('form');
    const field = (label, input, hint) => { form.appendChild(el('label', null, label)); form.appendChild(input); if (hint) form.appendChild(el('div', 'dm-hint', hint)); return input; };
    const date = el('input'); date.type = 'date'; date.value = todayEastern(); date.max = todayEastern(); date.required = true;
    field('Date paid', date);
    const amount = el('input'); amount.type = 'number'; amount.min = '0'; amount.step = '0.01'; amount.required = true;
    amount.value = settingsCache ? settingsCache.duesAmount : 15;
    field('Amount ($)', amount);
    const method = el('select');
    Object.entries(METHOD_LABELS).forEach(([v, t]) => { const o = el('option', null, t); o.value = v; method.appendChild(o); });
    field('Paid by', method);
    const note = el('input'); note.type = 'text'; note.maxLength = 300; note.placeholder = 'Optional, e.g. PayPal transaction ID or "paid at the March meeting"';
    field('Note', note);
    const err = el('div', 'dm-err');
    form.appendChild(err);
    const actions = el('div', 'dm-actions');
    const cancel = el('button', 'dm-cancel', 'Cancel'); cancel.type = 'button';
    const save = el('button', null, 'Save payment'); save.type = 'submit';
    actions.appendChild(cancel); actions.appendChild(save);
    form.appendChild(actions);
    box.appendChild(form);
    date.focus();
    cancel.addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true; err.textContent = '';
      try {
        const r = await api('POST', `/api/users/${encodeURIComponent(username)}/dues/payments`,
          { paidOn: date.value, amount: parseFloat(amount.value), method: method.value, note: note.value });
        refreshCell(username, r.dues);
        close();
      } catch (ex) { err.textContent = ex.message; save.disabled = false; }
    });
  }

  function showHistory(username) {
    const d = duesByUser.get(username);
    const { box, close } = modal(`Dues payments: ${username}`);
    const draw = (dd) => {
      [...box.querySelectorAll('table, .dm-empty, .dm-err')].forEach(n => n.remove());
      const pays = (dd && dd.payments) || [];
      if (!pays.length) { box.insertBefore(el('p', 'dm-empty', 'No payments recorded.'), actions); return; }
      const t = el('table');
      const hr = el('tr');
      ['Paid', 'Amount', 'How', 'Recorded by', ''].forEach(h => hr.appendChild(el('th', null, h)));
      t.appendChild(hr);
      pays.forEach(p => {
        const tr = el('tr');
        const c1 = el('td', null, fmtDate(p.paidOn));
        if (p.note) c1.appendChild(el('div', 'dm-hint', p.note));
        tr.appendChild(c1);
        tr.appendChild(el('td', null, money(p.amount)));
        tr.appendChild(el('td', null, METHOD_LABELS[p.method] || p.method));
        tr.appendChild(el('td', null, `${p.recordedBy || ''} ${p.recordedAt ? '(' + fmtWhen(p.recordedAt) + ')' : ''}`));
        const c5 = el('td');
        const del = el('button', null, 'Delete'); del.type = 'button';
        del.title = 'Remove a payment entered by mistake';
        del.addEventListener('click', async () => {
          if (!confirm(`Delete the ${money(p.amount)} payment from ${fmtDate(p.paidOn)}? The expiry date will be recalculated.`)) return;
          try {
            const r = await api('DELETE', `/api/users/${encodeURIComponent(username)}/dues/payments/${encodeURIComponent(p.id)}`);
            duesByUser.set(username, r.dues); refreshCell(username, r.dues); draw(r.dues);
          } catch (ex) { box.insertBefore(el('div', 'dm-err', 'Could not delete: ' + ex.message), actions); }
        });
        c5.appendChild(del);
        tr.appendChild(c5);
        t.appendChild(tr);
      });
      box.insertBefore(t, actions);
    };
    const actions = el('div', 'dm-actions');
    const ok = el('button', null, 'Close'); ok.type = 'button'; ok.addEventListener('click', close);
    actions.appendChild(ok);
    box.appendChild(actions);
    draw(d);
  }

  async function sendNotice(username, btn) {
    if (!confirm(`Email ${username} that their dues are overdue and they should pay to regain access?`)) return;
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await api('POST', `/api/users/${encodeURIComponent(username)}/dues/notice`);
      refreshCell(username, r.dues);
    } catch (ex) {
      alert('Could not send the email: ' + ex.message);
      btn.disabled = false; btn.textContent = 'Send dues email';
    }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-dues-action]');
    if (!b) return;
    const u = b.dataset.username;
    if (b.dataset.duesAction === 'record') recordPayment(u);
    else if (b.dataset.duesAction === 'history') showHistory(u);
    else if (b.dataset.duesAction === 'notice') sendNotice(u, b);
  });

  // ---------- Account Management: Membership Dues card (webmasters) ----------
  let settingsCache = null;

  // Collapsed/expanded state is per-browser (localStorage), not per-account
  // server state - purely a "get it out of my way" convenience, collapsed
  // by default (hence checking for the explicit opt-out below, not an
  // explicit opt-in) so it stays out of the way until a webmaster actually
  // wants it.
  const DUES_SECTION_COLLAPSED_KEY = 'duesSectionCollapsed';

  async function renderSettings() {
    const root = document.getElementById('dues-settings-section');
    if (!root) return;
    injectStyles();
    root.textContent = '';

    const details = el('details');
    let startCollapsed = true;
    try { startCollapsed = localStorage.getItem(DUES_SECTION_COLLAPSED_KEY) !== 'false'; } catch (_) { /* ignore */ }
    details.open = !startCollapsed;
    details.addEventListener('toggle', () => {
      try { localStorage.setItem(DUES_SECTION_COLLAPSED_KEY, details.open ? 'false' : 'true'); } catch (_) { /* ignore */ }
    });
    details.appendChild(el('summary', null, 'Membership Dues'));
    root.appendChild(details);

    let s;
    try { s = settingsCache = await api('GET', '/api/dues/settings'); }
    catch (err) { details.appendChild(el('p', null, 'Could not load dues settings: ' + err.message)); return; }

    const row = (label, input, hint) => {
      const wrap = el('div'); wrap.style.margin = '8px 0';
      const l = el('label', null, label); l.style.display = 'block'; l.style.fontWeight = '600';
      wrap.appendChild(l); wrap.appendChild(input);
      if (hint) { const h = el('div', 'dues-sub', hint); wrap.appendChild(h); }
      details.appendChild(wrap);
      return input;
    };
    const amount = el('input'); amount.type = 'number'; amount.min = '0'; amount.step = '0.01'; amount.value = s.duesAmount; amount.style.maxWidth = '120px';
    row('Yearly dues ($)', amount, 'Used for new payments, emails and the Pay dues button. Past payments keep the amount actually paid.');
    const days = el('input'); days.type = 'number'; days.min = '1'; days.max = '180'; days.step = '1'; days.value = s.duesReminderDays; days.style.maxWidth = '120px';
    row('Send the reminder email this many days before a membership expires', days);

    const enfWrap = el('label'); enfWrap.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin:10px 0;';
    const enf = el('input'); enf.type = 'checkbox'; enf.checked = !!s.duesEnforcement; enf.style.cssText = 'width:18px;height:18px;margin-top:2px;';
    const enfText = el('span');
    enfText.appendChild(el('strong', null, 'Block members whose membership has expired'));
    enfText.appendChild(el('div', 'dues-sub', 'Off by default. When on, an expired member can still log in but only sees a "pay your dues" page. Never affects admins, webmasters, or members with no payment recorded.'));
    enfWrap.appendChild(enf); enfWrap.appendChild(enfText);
    details.appendChild(enfWrap);

    const save = el('button', 'btn-success', 'Save dues settings'); save.type = 'button';
    const note = el('span', 'dues-sub'); note.style.marginLeft = '10px';
    details.appendChild(save); details.appendChild(note);
    save.addEventListener('click', async () => {
      if (enf.checked && !s.duesEnforcement &&
          !confirm('Turn on blocking? Members whose recorded membership has expired will only see a "pay your dues" page until a payment is recorded.')) return;
      save.disabled = true; note.textContent = 'Saving…';
      try {
        const r = await api('POST', '/api/dues/settings', { duesAmount: parseFloat(amount.value), duesReminderDays: parseInt(days.value, 10), duesEnforcement: enf.checked });
        Object.assign(s, r); settingsCache = s; note.textContent = 'Saved.';
      } catch (err) { note.textContent = 'Could not save: ' + err.message; }
      save.disabled = false;
    });

    const sched = el('details'); sched.style.marginTop = '14px';
    sched.appendChild(el('summary', null, 'Automatic reminders: daily scheduled task (recommended)'));
    sched.appendChild(el('p', 'dues-sub', 'Reminders are checked every hour while the site is running. So they still go out on quiet days when the site is asleep, add a daily Plesk Scheduled Task: Websites & Domains → Scheduled Tasks → Add Task → "Fetch a URL", run Daily, with this URL. Keep it private.'));
    const url = el('input'); url.type = 'text'; url.readOnly = true; url.value = s.reminderUrl; url.style.cssText = 'width:100%;max-width:640px;font-family:monospace;font-size:12px;padding:5px;';
    sched.appendChild(url);
    const copy = el('button', null, 'Copy URL'); copy.type = 'button'; copy.style.marginTop = '6px';
    copy.addEventListener('click', () => { url.select(); (navigator.clipboard ? navigator.clipboard.writeText(url.value) : Promise.reject()).catch(() => document.execCommand('copy')); copy.textContent = 'Copied'; });
    sched.appendChild(copy);
    details.appendChild(sched);
  }

  // Load the dues price for the Record payment form once Account Management opens
  async function loadSettingsQuietly() {
    try { settingsCache = await api('GET', '/api/dues/settings'); } catch (_) { /* not a webmaster */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Webmasters get the Membership Dues card at the top of Account
    // Management (the Treasurer view has its own price box)
    const am = document.querySelector('.tab[data-tab="account-management"]');
    if (am) am.addEventListener('click', () => {
      if (sessionStorage.getItem('role') === 'webmaster') renderSettings();
    });
  });

  // ---------- Treasurer view of Account Management ----------
  const STATUS_LABEL = { active: 'Active', pending: 'Pending approval', inactive: 'Inactive' };
  let tvState = { q: '', filter: 'all', members: [] };

  function setWebmasterParts(visible) {
    const root = document.getElementById('account-management');
    if (!root) return;
    root.querySelectorAll(':scope > .account-management-controls').forEach(n => { n.style.display = visible ? '' : 'none'; });
    const tv = document.getElementById('treasurer-view');
    if (tv) tv.style.display = visible ? 'none' : '';
    const intro = document.getElementById('account-management-intro');
    if (intro) intro.textContent = visible
      ? 'Manage user accounts, permissions, and security settings.'
      : 'Check members\' dues, record payments, and set member accounts active once they\'ve paid.';
  }

  function showWebmasterView() { setWebmasterParts(true); }

  async function showTreasurerView() {
    injectStyles();
    setWebmasterParts(false);
    const root = document.getElementById('treasurer-view');
    if (!root) return;
    root.textContent = 'Loading…';
    try {
      const [list] = await Promise.all([api('GET', '/api/dues/members'), loadSettingsQuietly()]);
      tvState.members = list.members || [];
      drawTreasurer();
    } catch (err) {
      root.textContent = 'Could not load members: ' + err.message;
    }
  }

  function drawTreasurer() {
    const root = document.getElementById('treasurer-view');
    root.textContent = '';
    const all = tvState.members;
    const count = (st) => all.filter(m => m.dues && m.dues.state === st).length;
    root.appendChild(el('p', 'tv-summary',
      `${plural(all.length, 'member')}: ${count('paid')} paid, ${count('due-soon')} due soon, ${count('expired')} expired, ` +
      `${count('none')} with no payment recorded, ${all.filter(m => m.status === 'pending').length} waiting for approval.`));

    // The Treasurer can change the dues price
    const price = el('div', 'tv-price');
    price.appendChild(el('label', null, 'Yearly dues ($)'));
    const amt = el('input'); amt.type = 'number'; amt.min = '0'; amt.step = '0.01';
    amt.value = settingsCache ? settingsCache.duesAmount : '';
    const saveAmt = el('button', null, 'Save price'); saveAmt.type = 'button';
    const amtNote = el('span', 'dues-sub', 'Used for new payments, emails and the Pay dues button. Past payments keep the amount actually paid.');
    price.appendChild(amt); price.appendChild(saveAmt); price.appendChild(amtNote);
    saveAmt.addEventListener('click', async () => {
      const v = parseFloat(amt.value);
      if (!(v >= 0)) { amtNote.textContent = 'Enter an amount.'; return; }
      if (settingsCache && v === settingsCache.duesAmount) { amtNote.textContent = 'That is already the price.'; return; }
      if (!confirm(`Change the yearly dues to ${money(v)}?`)) return;
      saveAmt.disabled = true;
      try {
        const r = await api('POST', '/api/dues/settings', { duesAmount: v });
        settingsCache = Object.assign(settingsCache || {}, r);
        amt.value = r.duesAmount;
        amtNote.textContent = `Saved. Yearly dues are now ${money(r.duesAmount)}.`;
      } catch (err) { amtNote.textContent = 'Could not save: ' + err.message; }
      saveAmt.disabled = false;
    });
    root.appendChild(price);

    const bar = el('div', 'tv-bar');
    const search = el('input'); search.type = 'text'; search.placeholder = 'Search by username, name or email…'; search.value = tvState.q;
    const filter = el('select');
    [['all', 'All members'], ['pending', 'Waiting for approval'], ['expired', 'Dues expired'], ['due-soon', 'Dues due soon'],
     ['none', 'No payment recorded'], ['paid', 'Paid up'], ['inactive', 'Inactive accounts']]
      .forEach(([v, t]) => { const o = el('option', null, t); o.value = v; filter.appendChild(o); });
    filter.value = tvState.filter;
    bar.appendChild(search); bar.appendChild(filter);
    root.appendChild(bar);

    const wrap = el('div', 'tv-wrap');
    const table = el('table');
    const thead = el('tr');
    ['Member', 'Email', 'Account', 'Dues'].forEach(h => thead.appendChild(el('th', null, h)));
    table.appendChild(thead);
    const body = el('tbody');
    table.appendChild(body);
    wrap.appendChild(table);
    root.appendChild(wrap);

    const rows = () => {
      body.textContent = '';
      const q = tvState.q.trim().toLowerCase();
      const shown = all.filter(m =>
        (!q || [m.username, m.fullName, m.email].some(v => (v || '').toLowerCase().includes(q))) &&
        (tvState.filter === 'all' ||
          (['pending', 'inactive'].includes(tvState.filter) ? m.status === tvState.filter : m.dues && m.dues.state === tvState.filter)));
      if (!shown.length) {
        const tr = el('tr'); const td = el('td', null, 'No members match.'); td.colSpan = 4; tr.appendChild(td); body.appendChild(tr);
        return;
      }
      shown.forEach(m => {
        const tr = el('tr');
        const who = el('td');
        who.appendChild(el('div', null, m.username));
        if (m.fullName) who.appendChild(el('div', 'dues-sub', m.fullName));
        tr.appendChild(who);
        tr.appendChild(el('td', null, m.email));
        const acct = el('td');
        acct.appendChild(el('div', 'tv-status ' + m.status, STATUS_LABEL[m.status] || m.status));
        const active = m.status === 'active';
        const b = el('button', 'tv-act' + (active ? ' deactivate' : ''), active ? 'Set inactive' : 'Set active');
        b.type = 'button';
        b.addEventListener('click', async () => {
          const msg = active ? `Set ${m.username}'s account inactive? They won't be able to log in.` : `Set ${m.username}'s account active? They'll be able to log in.`;
          if (!confirm(msg)) return;
          b.disabled = true;
          try { const r = await api('POST', `/api/dues/members/${encodeURIComponent(m.username)}/status`, { active: !active }); m.status = r.status; drawTreasurer(); }
          catch (err) { alert('Could not change the account: ' + err.message); b.disabled = false; }
        });
        acct.appendChild(b);
        tr.appendChild(acct);
        const dc = el('td');
        dc.innerHTML = duesCellHtml(m); // built from escaped values
        tr.appendChild(dc);
        body.appendChild(tr);
      });
    };
    search.addEventListener('input', () => { tvState.q = search.value; rows(); });
    filter.addEventListener('change', () => { tvState.filter = filter.value; rows(); });
    rows();
  }

  // Keep the Treasurer list in step after a payment / email / deletion
  const baseRefresh = refreshCell;
  refreshCell = function (username, d) {
    const m = tvState.members.find(x => x.username === username);
    if (m) m.dues = d;
    baseRefresh(username, d);
  };

  // ---------- Account Management: legal name column (webmasters) ----------
  function nameCellHtml(user) {
    injectStyles();
    const u = esc(user.username);
    const has = user.firstName && user.lastName;
    return `<div class="name-cell" data-name-user="${u}">
      ${has ? `<div>${esc(user.firstName)} ${esc(user.lastName)}</div>` : '<div class="dues-state none">Not given</div>'}
      <button type="button" class="dues-plain name-edit" data-name-edit data-username="${u}"
        data-first="${esc(user.firstName || '')}" data-last="${esc(user.lastName || '')}">${has ? 'Edit' : 'Add name'}</button>
    </div>`;
  }

  function editName(username, first, last) {
    const { box, close } = modal('Legal name');
    box.appendChild(el('div', 'dm-hint', `For ${username}. Used to identify the member; only webmasters can see it.`));
    const form = el('form');
    const f = el('input'); f.type = 'text'; f.maxLength = 50; f.required = true; f.value = first || '';
    const l = el('input'); l.type = 'text'; l.maxLength = 50; l.required = true; l.value = last || '';
    form.appendChild(el('label', null, 'First name')); form.appendChild(f);
    form.appendChild(el('label', null, 'Last name')); form.appendChild(l);
    const err = el('div', 'dm-err');
    form.appendChild(err);
    const actions = el('div', 'dm-actions');
    const cancel = el('button', 'dm-cancel', 'Cancel'); cancel.type = 'button';
    const save = el('button', null, 'Save'); save.type = 'submit';
    actions.appendChild(cancel); actions.appendChild(save);
    form.appendChild(actions);
    box.appendChild(form);
    f.focus();
    cancel.addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true; err.textContent = '';
      try {
        const r = await api('POST', `/api/users/${encodeURIComponent(username)}/name`, { firstName: f.value, lastName: l.value });
        const cell = [...document.querySelectorAll('[data-name-user]')].find(c => c.dataset.nameUser === username);
        if (cell) cell.outerHTML = nameCellHtml({ username, firstName: r.firstName, lastName: r.lastName });
        // Keep the page's cached user list (used by the search box) in step;
        // it's a top-level "let" in portal.html, visible here by name
        if (typeof lastLoadedUsers !== 'undefined' && Array.isArray(lastLoadedUsers)) {
          const u = lastLoadedUsers.find(x => x.username === username);
          if (u) Object.assign(u, { firstName: r.firstName, lastName: r.lastName, fullName: r.fullName });
        }
        close();
      } catch (ex) { err.textContent = ex.message; save.disabled = false; }
    });
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-name-edit]');
    if (b) editName(b.dataset.username, b.dataset.first, b.dataset.last);
  });

  // Webmaster: the Treasurer checkbox in the user table
  document.addEventListener('change', async (e) => {
    const box = e.target;
    if (!box.matches || !box.matches('[data-treasurer-toggle]')) return;
    const username = box.dataset.username;
    const want = box.checked;
    if (!confirm(want
      ? `Make ${username} a Treasurer? They'll be able to see all members, record dues payments, send dues emails and set member accounts active or inactive.`
      : `Remove ${username}'s Treasurer access?`)) { box.checked = !want; return; }
    box.disabled = true;
    try { await api('POST', `/api/users/${encodeURIComponent(username)}/treasurer`, { isTreasurer: want }); }
    catch (err) { alert('Could not change Treasurer access: ' + err.message); box.checked = !want; }
    box.disabled = false;
  });

  window.Membership = { afterLogin, hide, duesCellHtml, nameCellHtml, renderSettings, showTreasurerView, showWebmasterView };
})();
