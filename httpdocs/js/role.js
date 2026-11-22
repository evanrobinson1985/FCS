/*
 * The signed-in account's role, as the server reported it at login.
 *
 * Kept in memory only - not in localStorage/sessionStorage, where anyone can
 * edit it from the browser's developer tools. The page uses it to decide which
 * tabs and buttons to draw; it never grants anything, because the server checks
 * the real account on every request. The webmaster-only screens themselves
 * (Account Management, Website Management) aren't even in the page until the
 * server sends them to a confirmed webmaster or Treasurer - see loadPanels() in
 * portal.html and GET /api/panels/:name in server.js.
 */
(function () {
  'use strict';
  let role = '';
  let treasurer = false;
  window.FCSRole = Object.freeze({
    get: () => role,
    isWebmaster: () => role === 'webmaster',
    isTreasurer: () => treasurer,
    // From the server's login response only (completeLogin in portal.html)
    set(newRole, isTreasurer) { role = String(newRole || ''); treasurer = !!isTreasurer; },
    clear() { role = ''; treasurer = false; },
  });
})();
