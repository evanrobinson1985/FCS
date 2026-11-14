/*
 * "Who's online" notice for webmaster/admin/Treasurer: a small, persistent
 * count next to "Logged in as" on every page, and a brief toast when
 * someone logs in while this account is already using the site.
 *
 * The server itself refuses GET /api/active-sessions for anyone but a
 * webmaster, admin, or the Treasurer, so mayView() below is just about not
 * bothering everyone else with a pointless poll - it isn't the real gate.
 *
 * Polls GET /api/active-sessions every POLL_MS while logged in. The first
 * response after start() just establishes the badge and a baseline
 * sequence number, silently - only logins that happen on a LATER poll (a
 * genuinely new one, after this account was already watching) produce a
 * toast, so opening the page never dumps a backlog of "X just logged in"
 * notices for people who were already online.
 */
(function () {
  'use strict';

  const POLL_MS = 20000;
  const TOAST_MS = 7000;
  let pollTimer = null;
  let toastTimer = null;
  let sinceSeq = 0;
  let baselined = false;

  const token = () => sessionStorage.getItem('sessionToken');
  const myUsername = () => localStorage.getItem('username') || sessionStorage.getItem('username');
  const role = () => localStorage.getItem('role') || sessionStorage.getItem('role');
  const isTreasurer = () => sessionStorage.getItem('isTreasurer') === '1';
  const mayView = () => role() === 'webmaster' || role() === 'admin' || isTreasurer();

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function injectStyles() {
    if (document.getElementById('active-sessions-styles')) return;
    const style = document.createElement('style');
    style.id = 'active-sessions-styles';
    style.textContent = `
      .as-wrap { position: relative; display: inline-block; }
      .as-badge { display: inline-flex; align-items: center; gap: 5px; margin-left: 10px; padding: 3px 10px;
        border-radius: 999px; background: #eef6ee; color: #2a6b2a; font-size: 0.82em; font-weight: 600;
        border: 1px solid #cde6cd; vertical-align: middle; cursor: default; }
      .as-badge .as-dot { width: 7px; height: 7px; border-radius: 50%; background: #2fa63f; flex: none; }
      .as-wrap:hover .as-list { display: block; }
      .as-list { display: none; position: absolute; left: 0; top: 100%; z-index: 500; margin-top: 6px;
        background: #fff; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.12);
        padding: 8px 10px; font-size: 0.85em; font-weight: 400; color: #333; min-width: 170px; white-space: nowrap; }
      .as-list .as-list-row { padding: 2px 0; }
      .as-toast { position: fixed; right: 16px; bottom: 16px; z-index: 3200; background: #2a4d69; color: #fff;
        padding: 10px 16px; border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,0.25); font-size: 0.92em;
        max-width: 320px; opacity: 0; transform: translateY(8px); transition: opacity 0.25s, transform 0.25s; pointer-events: none; }
      .as-toast.as-toast-show { opacity: 1; transform: translateY(0); }
    `;
    document.head.appendChild(style);
  }

  function renderBadge(data) {
    const host = document.getElementById('logged-in-user');
    if (!host) return;
    injectStyles();
    let wrap = document.getElementById('active-sessions-badge-wrap');
    if (!wrap) {
      wrap = el('span', 'as-wrap');
      wrap.id = 'active-sessions-badge-wrap';
      host.insertAdjacentElement('afterend', wrap);
    }
    wrap.textContent = '';

    const badge = el('span', 'as-badge');
    badge.appendChild(el('span', 'as-dot'));
    badge.appendChild(document.createTextNode(`${data.count} online`));

    const list = el('div', 'as-list');
    const others = (data.users || []).filter((u) => u.username !== myUsername());
    if (!others.length) {
      list.appendChild(el('div', 'as-list-row', 'Just you right now.'));
    } else {
      others.forEach((u) => list.appendChild(el('div', 'as-list-row', u.username)));
    }
    badge.appendChild(list);
    wrap.appendChild(badge);
  }

  function showToast(text) {
    injectStyles();
    let toast = document.getElementById('active-sessions-toast');
    if (!toast) {
      toast = el('div', 'as-toast');
      toast.id = 'active-sessions-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    // Re-trigger the fade-in even if a toast is already showing, so a
    // second notice while the first is still up still resets the clock.
    toast.classList.remove('as-toast-show');
    void toast.offsetWidth;
    toast.classList.add('as-toast-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('as-toast-show'), TOAST_MS);
  }

  async function poll() {
    const t = token();
    if (!t || !mayView()) return;
    try {
      const res = await fetch(`/api/active-sessions?since=${sinceSeq}`, {
        headers: { Authorization: 'Bearer ' + t },
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = await res.json();
      renderBadge(data);

      if (baselined) {
        const mine = myUsername();
        const newLogins = (data.events || []).filter((e) => e.username !== mine);
        if (newLogins.length) {
          const last = newLogins[newLogins.length - 1];
          const name = last.fullName || last.username;
          showToast(newLogins.length === 1
            ? `${name} just logged in.`
            : `${newLogins.length} people just logged in, including ${name}.`);
        }
      }
      baselined = true;
      sinceSeq = data.latestSeq;
    } catch (err) {
      console.warn('Could not check active sessions:', err);
    }
  }

  function start() {
    if (!mayView()) return;
    stop();
    sinceSeq = 0;
    baselined = false;
    poll();
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') poll(); }, POLL_MS);
  }

  function stop() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    const wrap = document.getElementById('active-sessions-badge-wrap');
    if (wrap) wrap.remove();
    const toast = document.getElementById('active-sessions-toast');
    if (toast) toast.remove();
  }

  window.ActiveSessions = { start, stop };
})();
