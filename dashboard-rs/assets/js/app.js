/* Admin Dashboard shell glue (no framework).
 *
 * Port of the viewport tracking in dashboard/src/main.tsx: when the
 * software keyboard opens, iOS Safari doesn't resize the layout viewport —
 * only the visual viewport — so a full-height app shell would leave inputs
 * behind the keyboard. Publish the visual viewport height as --app-h; the
 * shell (default 100vh, correct from cold start in a standalone PWA)
 * tracks the really-visible area.
 *
 * Second half: iOS also pans the visual viewport to "reveal" the focused
 * input. Publish that pan origin as --vv-top; the shell rides it via `top`
 * (see .app-shell in app.css) so it keeps filling the visible band even
 * when the pan sticks. `top` on a relatively-positioned shell is
 * deliberate: unlike transform/translate it doesn't become the containing
 * block for the viewport-fixed bottom pill.
 */

(function () {
  "use strict";

  var maxViewportH =
    (window.visualViewport && window.visualViewport.height) ||
    window.innerHeight;

  function syncViewport() {
    var vv = window.visualViewport;
    var h = (vv && vv.height) || window.innerHeight;
    if (h > maxViewportH) maxViewportH = h;
    var root = document.documentElement;
    root.style.setProperty("--app-h", Math.round(h) + "px");
    var top = vv ? vv.offsetTop || 0 : 0;
    root.style.setProperty("--vv-top", Math.round(Math.max(0, top)) + "px");
  }

  function typingActive() {
    var root = document.documentElement;
    return (
      root.classList.contains("chat-typing") ||
      root.classList.contains("modal-typing")
    );
  }

  // iOS standalone PWA quirk: the first keyboard open shrinks the reported
  // viewport height and it never grows back on close — the shell stays
  // short and bottom chrome floats high over a dead strip until the app is
  // force-quit. Force a re-measure once the keyboard closes by flipping
  // the shell off and on with a synchronous reflow in between.
  function healViewport() {
    var cur =
      (window.visualViewport && window.visualViewport.height) ||
      window.innerHeight;
    if (maxViewportH - cur <= 4) {
      syncViewport();
      return;
    }
    var shell = document.querySelector(".app-shell");
    if (!shell) {
      syncViewport();
      return;
    }
    shell.style.display = "none";
    void shell.offsetHeight;
    shell.style.display = "";
    syncViewport();
    window.scrollTo(0, 0);
  }

  // Sync eagerly: the first values during a PWA splash→standalone
  // transition can predate settled chrome metrics, so re-sync on every
  // signal that metrics may have settled.
  syncViewport();
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", function () {
      syncViewport();
      if (typingActive()) window.scrollTo(0, 0);
    });
    window.visualViewport.addEventListener("scroll", function () {
      syncViewport();
      if (typingActive()) window.scrollTo(0, 0);
    });
  }
  window.addEventListener("resize", function () {
    syncViewport();
    window.scrollTo(0, 0);
  });
  window.addEventListener("load", syncViewport);
  window.addEventListener("pageshow", syncViewport);
  window.addEventListener("orientationchange", syncViewport);
  window.addEventListener("scroll", function () {
    syncViewport();
    window.scrollTo(0, 0);
  }, { once: true });

  // Pre-empt the pan: a text-input focus is always followed by the keyboard
  // (and its pan) on mobile. Reset the scroll before the animation starts.
  document.addEventListener("focusin", function (e) {
    var t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.tagName === "TEXTAREA" || t.tagName === "INPUT")
    ) {
      syncViewport();
      window.scrollTo(0, 0);
    }
  });
  // The typing flags clear on blur; once neither is set the keyboard is
  // gone — heal a stuck-shrunk viewport then, delayed past the iOS
  // keyboard-close animation so the re-measure reads the restored height.
  document.addEventListener("focusout", function () {
    setTimeout(function () {
      var root = document.documentElement;
      if (
        !root.classList.contains("chat-typing") &&
        !root.classList.contains("modal-typing")
      ) {
        healViewport();
      }
    }, 150);
  });

  // NOTE: no service worker, by decision. This dashboard is
  // connection-only (every route needs the server), so an offline shell
  // would never be useful — the installed PWA is manifest + meta tags
  // only (see docs/rust-port.md Phase 6).
})();
