/*
 * The signed-in account's role, read from the login token the server signed.
 *
 * The page uses it only to decide which tabs and buttons to draw; it never
 * grants anything, because the server checks the real account on every
 * request. It's taken from the token itself (not kept in localStorage /
 * sessionStorage or set by the page), so the only way to change it is to edit
 * the token - which breaks the server's signature and ends that session: every
 * request is refused. The webmaster and admin controls that aren't drawn by the
 * page (Account Management, Website Management, Upload Cave Maps) aren't even in
 * it until the server sends them to a confirmed account - see loadPanels() in
 * portal.html and GET /api/panels/:name in server.js.
 */
(function () {
  'use strict';
  let treasurer = false;

  // The role claim in the session token (a JWT: header.payload.signature)
  function tokenRole() {
    try {
      const token = sessionStorage.getItem('sessionToken');
      if (!token) return '';
      const part = token.split('.')[1] || '';
      const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
      const role = JSON.parse(json).role;
      return role === 'member' || role === 'admin' || role === 'webmaster' ? role : '';
    } catch (e) {
      return '';
    }
  }

  window.FCSRole = Object.freeze({
    get: tokenRole,
    isWebmaster: () => tokenRole() === 'webmaster',
    isAdminOrWebmaster: () => tokenRole() === 'admin' || tokenRole() === 'webmaster',
    // The Treasurer permission, from the server's login reply. It only decides
    // whether the Account Management tab is offered; its contents come from the
    // server, which checks the permission itself.
    isTreasurer: () => treasurer,
    set(_role, isTreasurer) { treasurer = !!isTreasurer; },
    clear() { treasurer = false; },
  });
})();
