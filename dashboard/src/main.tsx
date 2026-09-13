import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Keyboard-aware viewport: when the software keyboard opens, iOS Safari
// doesn't resize the layout viewport — only the visual viewport — so a
// full-height app shell would leave the chat composer behind the keyboard.
// Publish the visual viewport height as --app-h; the shell (default 100vh,
// correct from cold start in a standalone PWA) tracks the really-visible
// area and the composer stays above the keyboard.
//
// Second half of the same problem: iOS also pans the visual viewport to
// "reveal" the focused input. The shrunken shell sits at the top of the
// layout viewport, so a stuck pan views it through an offset window — only
// the shell's bottom slice (the composer) shows, pinned to the top of the
// screen with dead background below it. Publish that pan origin as
// --vv-top; the shell rides it via `top` (see .app-shell in app.css) so it
// keeps filling the visible band even when the pan sticks. `top` on a
// relatively-positioned shell is deliberate: unlike transform/translate it
// doesn't become the containing block for the viewport-fixed bottom pill.
let maxViewportH = window.visualViewport?.height ?? window.innerHeight;
function syncViewport() {
  const vv = window.visualViewport;
  const h = vv?.height ?? window.innerHeight;
  maxViewportH = Math.max(maxViewportH, h);
  const root = document.documentElement;
  root.style.setProperty("--app-h", `${Math.round(h)}px`);
  const top = vv ? (vv.offsetTop || 0) : 0;
  root.style.setProperty("--vv-top", `${Math.round(Math.max(0, top))}px`);
}
function typingActive(): boolean {
  const root = document.documentElement;
  return root.classList.contains("chat-typing") || root.classList.contains("modal-typing");
}
// iOS standalone PWA quirk: the first keyboard open shrinks the reported
// viewport height and it never grows back on close — the shell stays short
// and bottom chrome floats high over a dead strip until the app is
// force-quit. Don't fight the shrink (the composer needs it while typing);
// force a re-measure once the keyboard closes by flipping the shell off and
// on with a synchronous reflow in between.
function healViewport() {
  const cur = window.visualViewport?.height ?? window.innerHeight;
  if (maxViewportH - cur <= 4) {
    syncViewport();
    return;
  }
  const shell = document.querySelector(".app-shell") as HTMLElement | null;
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
// Sync eagerly: the first values during a PWA splash→standalone transition
// can predate settled chrome metrics (the floating pill then sits high
// until a scroll corrects it), so re-sync on every signal that metrics
// may have settled — load, pageshow (bfcache), orientation, and once on
// the first scroll as a backstop.
syncViewport();
// visualViewport resize fires on keyboard open/close (the layout viewport
// never resizes in the standalone PWA, so `window resize` below is dead in
// exactly the keyboard case — the pan-undo must live here too). The
// scrollTo is gated on a typing session so pinch-zoom pans are untouched;
// the --vv-top glue above covers whatever pan remains either way.
window.visualViewport?.addEventListener("resize", () => {
  syncViewport();
  if (typingActive()) window.scrollTo(0, 0);
});
// visualViewport scroll IS the keyboard pan event. Re-sync so --vv-top
// tracks it and the shell rides the pan instead of being seen through it.
window.visualViewport?.addEventListener("scroll", () => {
  syncViewport();
  if (typingActive()) window.scrollTo(0, 0);
});
window.addEventListener("resize", () => {
  syncViewport();
  // Undo the pan iOS applies to the layout viewport when the keyboard opens.
  window.scrollTo(0, 0);
});
window.addEventListener("load", syncViewport);
window.addEventListener("pageshow", syncViewport);
window.addEventListener("orientationchange", syncViewport);
window.addEventListener(
  "scroll",
  () => {
    syncViewport();
    window.scrollTo(0, 0);
  },
  { once: true },
);
// Pre-empt the pan: a text-input focus is always followed by the keyboard
// (and its pan) on mobile. Reset the scroll before the animation starts;
// the visualViewport listeners above then track the rest of it. Gated on
// the event target (React sets the typing classes async after this fires).
document.addEventListener("focusin", (e) => {
  const t = e.target;
  if (t instanceof HTMLElement && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) {
    syncViewport();
    window.scrollTo(0, 0);
  }
});
// The typing flags (chat-typing / modal-typing) clear on blur; once neither
// is set the keyboard is gone — heal a stuck-shrunk viewport then (see
// healViewport above). Delayed past the iOS keyboard-close animation so the
// re-measure reads the restored height.
document.addEventListener("focusout", () => {
  setTimeout(() => {
    const root = document.documentElement;
    if (
      !root.classList.contains("chat-typing") &&
      !root.classList.contains("modal-typing")
    ) {
      healViewport();
    }
  }, 150);
});

// PWA: register the service worker in production builds only — vite's dev
// server would otherwise cache-bust modules the SW can't serve.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Installability is best-effort; the app works without the SW.
    });
  });
}
