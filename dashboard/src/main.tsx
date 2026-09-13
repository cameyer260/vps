import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Keyboard-aware viewport height: when the software keyboard opens, iOS
// Safari doesn't resize the layout viewport — only the visual viewport — so
// a full-height app shell would leave the chat composer behind the keyboard.
// Publish the visual viewport height as --app-h; the shell (default 100vh,
// correct from cold start in a standalone PWA) tracks the really-visible
// area and the composer stays above the keyboard.
let maxViewportH = window.visualViewport?.height ?? window.innerHeight;
function syncViewportHeight() {
  const h = window.visualViewport?.height ?? window.innerHeight;
  maxViewportH = Math.max(maxViewportH, h);
  document.documentElement.style.setProperty("--app-h", `${Math.round(h)}px`);
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
    syncViewportHeight();
    return;
  }
  const shell = document.querySelector(".app-shell") as HTMLElement | null;
  if (!shell) {
    syncViewportHeight();
    return;
  }
  shell.style.display = "none";
  void shell.offsetHeight;
  shell.style.display = "";
  syncViewportHeight();
  window.scrollTo(0, 0);
}
// Sync eagerly: the first values during a PWA splash→standalone transition
// can predate settled chrome metrics (the floating pill then sits high
// until a scroll corrects it), so re-sync on every signal that metrics
// may have settled — load, pageshow (bfcache), orientation, and once on
// the first scroll as a backstop.
syncViewportHeight();
window.visualViewport?.addEventListener("resize", syncViewportHeight);
window.visualViewport?.addEventListener("scroll", syncViewportHeight);
window.addEventListener("resize", () => {
  syncViewportHeight();
  // Undo the pan iOS applies to the layout viewport when the keyboard opens.
  window.scrollTo(0, 0);
});
window.addEventListener("load", syncViewportHeight);
window.addEventListener("pageshow", syncViewportHeight);
window.addEventListener("orientationchange", syncViewportHeight);
window.addEventListener(
  "scroll",
  () => {
    syncViewportHeight();
    window.scrollTo(0, 0);
  },
  { once: true },
);
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
