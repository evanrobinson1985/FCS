/*
 * Cave Jump Top 10 (on /cave-jump and the maintenance page).
 *
 * Shows the leaderboard (GET /api/cave-jump/leaderboard) under the game.
 * When a run ends (the "cavejump:gameover" event from js/game.js), a
 * logged-in player's score is saved under their username (POST
 * /api/cave-jump/scores); the board keeps each account's best. Players who
 * aren't logged in can still play and see the board, and are told how to
 * get their name on it. The login comes from the portal's session in this
 * same tab (sessionStorage), so it works when the game is opened from the
 * portal's footer link.
 *
 * Names and numbers are inserted with textContent, never as HTML.
 */
(function () {
  'use strict';

  const token = () => { try { return sessionStorage.getItem('sessionToken'); } catch (_) { return null; } };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const authHeaders = () => (token() ? { Authorization: 'Bearer ' + token() } : {});
  let last = null;

  function injectStyles() {
    if (document.getElementById('cj-board-style')) return;
    const st = document.createElement('style');
    st.id = 'cj-board-style';
    st.textContent = `
      .cj-board { width: 100%; max-width: 460px; margin: 22px auto 0; padding: 14px 18px 16px; border-radius: 12px;
        background: rgba(255,255,255,0.04); border: 1px solid rgba(255,207,92,0.25); box-sizing: border-box; }
      .cj-board h2 { margin: 0 0 10px; text-align: center; color: var(--amber, #ffcf5c); font-size: 1.25rem; letter-spacing: 0.5px; }
      .cj-board ol { list-style: none; margin: 0; padding: 0; }
      .cj-board li { display: flex; align-items: center; gap: 10px; padding: 6px 4px; border-bottom: 1px solid rgba(255,255,255,0.06); }
      .cj-board li:last-child { border-bottom: none; }
      .cj-board .cj-rank { width: 2.2em; text-align: right; color: var(--text-dim, #a9a3b8); font-variant-numeric: tabular-nums; }
      .cj-board li:nth-child(1) .cj-rank { color: #ffcf5c; } .cj-board li:nth-child(2) .cj-rank { color: #d9dde6; } .cj-board li:nth-child(3) .cj-rank { color: #e0a36b; }
      .cj-board .cj-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cj-board .cj-score { font-weight: 700; font-variant-numeric: tabular-nums; }
      .cj-board li.cj-me { background: rgba(255,207,92,0.10); border-radius: 6px; }
      .cj-board .cj-del { background: none; border: none; color: #f87171; cursor: pointer; font-size: 1rem; padding: 0 2px; }
      .cj-board .cj-note { margin: 10px 0 0; text-align: center; color: var(--text-dim, #a9a3b8); font-size: 0.85rem; line-height: 1.45; }
      .cj-board .cj-note a, .cj-save a { color: var(--amber, #ffcf5c); }
      .cj-board .cj-empty { text-align: center; color: var(--text-dim, #a9a3b8); padding: 8px 0; }
      .cj-save { margin: 8px 0 0; color: var(--amber, #ffcf5c); font-size: 0.95rem; }
    `;
    document.head.appendChild(st);
  }

  function render(data) {
    const root = document.getElementById('cj-board');
    if (!root || !data) return;
    last = data;
    root.textContent = '';
    root.appendChild(el('h2', null, '🏆 Top 10'));
    const top = data.top || [];
    if (!top.length) {
      root.appendChild(el('div', 'cj-empty', 'No scores yet. Be the first!'));
    } else {
      const ol = el('ol');
      top.forEach(e => {
        const li = el('li', data.you && data.you.name === e.name ? 'cj-me' : null);
        li.appendChild(el('span', 'cj-rank', '#' + e.rank));
        li.appendChild(el('span', 'cj-name', e.name));
        li.appendChild(el('span', 'cj-score', String(e.score)));
        if (data.canManage && e.id) {
          const del = el('button', 'cj-del', '×');
          del.type = 'button'; del.title = 'Remove this score from the board';
          del.addEventListener('click', async () => {
            if (!confirm(`Remove ${e.name}'s score of ${e.score} from the Top 10?`)) return;
            try {
              const r = await fetch('/api/cave-jump/scores/' + encodeURIComponent(e.id), { method: 'DELETE', headers: authHeaders() });
              if (r.ok) render(await r.json());
            } catch (_) { /* leave as is */ }
          });
          li.appendChild(del);
        }
        ol.appendChild(li);
      });
      root.appendChild(ol);
    }
    const note = el('p', 'cj-note');
    if (data.you) {
      if (data.you.best != null) {
        note.textContent = `Your best: ${data.you.best} (#${data.you.rank}), playing as ${data.you.name}.`;
      } else {
        note.textContent = `Playing as ${data.you.name}. Your scores are saved here automatically.`;
      }
    } else {
      note.appendChild(document.createTextNode('Want your name on the board? '));
      const a = el('a', null, 'Log in to the Florida Cave Survey');
      a.href = '/portal';
      note.appendChild(a);
      note.appendChild(document.createTextNode(', then open Cave Jump from the link at the bottom of the page.'));
    }
    root.appendChild(note);
  }

  async function load() {
    try {
      const r = await fetch('/api/cave-jump/leaderboard', { headers: authHeaders() });
      if (r.ok) render(await r.json());
    } catch (_) { /* board just stays as it was */ }
  }

  function saveMessage(text, withLoginLink) {
    const msg = document.getElementById('gameOverMsg');
    if (!msg) return;
    let p = document.getElementById('cjSaveMsg');
    if (!p) { p = el('p', 'cj-save'); p.id = 'cjSaveMsg'; msg.parentNode.insertBefore(p, msg.nextSibling); }
    p.textContent = text;
    if (withLoginLink) {
      p.appendChild(document.createTextNode(' '));
      const a = el('a', null, 'Log in');
      a.href = '/portal';
      p.appendChild(a);
      p.appendChild(document.createTextNode(' to put your name on the Top 10.'));
    }
  }

  window.addEventListener('cavejump:gameover', async (e) => {
    const { score, seconds } = e.detail || {};
    if (!token()) {
      const tenth = last && last.top && last.top.length >= 10 ? last.top[9].score : -1;
      saveMessage(score > tenth ? 'That would make the Top 10!' : '', true);
      return;
    }
    saveMessage('Saving your score…');
    try {
      const r = await fetch('/api/cave-jump/scores', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ score, seconds })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) saveMessage('Your login has expired, so this score wasn\'t saved.', true);
        else saveMessage(data.error || 'Your score couldn\'t be saved.');
        return;
      }
      render(data);
      const you = data.you || {};
      if (data.isNewBest && you.rank && you.rank <= 10) saveMessage(`New personal best! You're #${you.rank} on the Top 10.`);
      else if (data.isNewBest) saveMessage(`New personal best, saved as ${you.name}. Rank #${you.rank}.`);
      else saveMessage(`Your best is still ${you.best}${you.rank && you.rank <= 10 ? ` (#${you.rank} on the Top 10)` : ''}.`);
    } catch (_) {
      saveMessage('Your score couldn\'t be saved (no connection).');
    }
  });

  function init() {
    if (!document.getElementById('cj-board')) return;
    injectStyles();
    load();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
