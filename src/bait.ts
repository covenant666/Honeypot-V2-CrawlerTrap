// ============================================================
// HoneyPot v2 — Dynamic Bait Injection
// MIT License — see LICENSE
//
// Generates a JavaScript snippet for injection into HTML pages.
// Creates invisible trap links that only bots/scrapers follow.
// Only fires AFTER user interaction or a timeout to avoid
// interfering with real user page load.
// ============================================================

import type { BaitOptions } from "./types";

const DEFAULT_PATHS = [
  "/admin/login",
  "/api/v2/users",
  "/.env",
];

/**
 * Returns a `<script>...</script>` string for injection into `<head>`.
 *
 * What it does:
 * 1. Immediately sets a proof-of-JS cookie (`_hpv`) — real browsers
 *    execute JS, bots often don't. This cookie gets checked by the orchestrator.
 * 2. After `injectDelay` ms, creates invisible `<a>` links with trap paths.
 *    Bots that follow every link will hit these traps, scoring +20 per hit.
 *
 * @param opts - Customization options (paths, cookie name, delay, expiry)
 * @returns HTML string with `<script>` wrapper
 */
export function getBaitScript(opts: BaitOptions = { paths: DEFAULT_PATHS }): string {
  const {
    paths,
    cookieName = "_hpv",
    injectDelay = 3000,
    cookieExpiryDays = 1,
  } = opts;

  const expiryMs = cookieExpiryDays * 86400000;

  // JSON-encode the paths array for safe injection into JS
  const pathsJson = JSON.stringify(paths);

  return `
<script>
(function(){
  // Step 1: Set proof-of-JS cookie immediately
  try {
    var d = new Date();
    d.setTime(d.getTime() + ${expiryMs});
    var proof = btoa(String(Date.now()) + ':' + navigator.userAgent.length);
    document.cookie = "${cookieName}=" + proof + ";expires=" + d.toUTCString() + ";path=/;SameSite=Lax;Secure";
  } catch(e) {}

  // Step 2: Inject trap links after delay
  setTimeout(function() {
    try {
      var paths = ${pathsJson};
      var container = document.createElement('nav');
      container.setAttribute('aria-hidden', 'true');
      container.style.cssText =
        'position:absolute;width:1px;height:1px;overflow:hidden;' +
        'clip-path:inset(50%);white-space:nowrap;z-index:-9999';
      paths.forEach(function(p) {
        var a = document.createElement('a');
        a.href = p;
        a.tabIndex = -1;
        a.rel = 'nofollow';
        a.title = '';
        a.textContent = p.substring(p.lastIndexOf('/') + 1);
        container.appendChild(a);
      });
      var bodyChildren = document.body.children;
      if (bodyChildren.length > 2) {
        var idx = Math.floor(Math.random() * (bodyChildren.length - 1)) + 1;
        document.body.insertBefore(container, bodyChildren[idx]);
      } else if (document.body) {
        document.body.appendChild(container);
      }
    } catch(e) {}
  }, ${injectDelay});
})();
</script>`;
}
