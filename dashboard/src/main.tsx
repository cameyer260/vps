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
// a 100dvh app shell keeps its full height and the chat composer ends up
// behind the keyboard. Publish the visual viewport height as --app-h; the
// shell (default 100dvh) tracks the really-visible area and the composer
// stays above the keyboard.
function syncViewportHeight() {
  const h = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-h", `${Math.round(h)}px`);
}
syncViewportHeight();
window.visualViewport?.addEventListener("resize", syncViewportHeight);
window.visualViewport?.addEventListener("scroll", syncViewportHeight);
window.addEventListener("resize", () => {
  syncViewportHeight();
  // Undo the pan iOS applies to the layout viewport when the keyboard opens.
  window.scrollTo(0, 0);
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
