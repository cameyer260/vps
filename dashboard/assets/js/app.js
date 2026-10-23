/* Site glue (no framework).
 *
 * htmx does the swapping; this file holds the few behaviours that neither htmx
 * nor the server-rendered markup covers: the phone sidebar toggle, the tree's
 * active row, the attachment dialog and local-time timestamps.
 */

(function () {
  "use strict";

  var DIALOG_TIMEOUT_MS = 5000;
  var dialogTimer = null;

  // Installed on a phone: mark the document so the CSS shows the status-bar
  // strip. `@media (display-mode: standalone)` is the first trigger; iOS has
  // reported the display mode inconsistently for home-screen apps, so
  // `navigator.standalone` backs it up. Touch-only, because a desktop-installed
  // app has no status bar and the strip would cover the sidebar's top edge.
  function markInstalled() {
    var media = window.matchMedia;
    var installed =
      window.navigator.standalone === true ||
      (media && media("(display-mode: standalone)").matches);
    var touch = media && media("(hover: none) and (pointer: coarse)").matches;
    if (installed && touch) {
      document.documentElement.classList.add("is-standalone");
    }
  }

  markInstalled();

  function closest(event, selector) {
    return event.target && event.target.closest
      ? event.target.closest(selector)
      : null;
  }

  function appShell() {
    return document.querySelector(".app-shell");
  }

  // The phone sidebar has two faces — the class and `aria-expanded` on the
  // fixed toggle — and a swap closes it too, so both change together here.
  function setSidebarOpen(open) {
    var shell = appShell();
    if (!shell) return;
    shell.classList.toggle("sidebar-open", open);
    var toggle = document.querySelector(".sidebar-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function setActive(link) {
    var current = document.querySelector(".tree-file.active");
    if (current) current.classList.remove("active");
    if (link) link.classList.add("active");
  }

  // An in-page navigation swaps only the reading pane, so the tree keeps
  // whatever was open when the link was clicked. The link can point anywhere in
  // the vault, so the folders above the open note are opened here — otherwise
  // the highlighted row sits inside collapsed folders and the tree says nothing
  // about where the reader is. Only that chain is touched: folders the reader
  // opened themselves stay open.
  function reveal(link) {
    if (!link || !link.closest) return;
    var folder = link.closest("details.tree-folder");
    while (folder) {
      folder.open = true;
      folder = folder.parentElement
        ? folder.parentElement.closest("details.tree-folder")
        : null;
    }
  }

  // The filtered tree is re-rendered server-side, so the highlight is reapplied
  // from the URL whenever the rows or the pane are swapped; the row's folders
  // are opened with it, and the server renders the same chain open for a whole
  // page (`notes.rs`).
  function refreshActive() {
    var path = window.location.pathname;
    var match = null;
    document
      .querySelectorAll(".tree-file:not(.attachment)")
      .forEach(function (row) {
        if (row.getAttribute("href") === path) match = row;
      });
    setActive(match);
    reveal(match);
  }

  // Phone sidebar toggle.
  document.addEventListener("click", function (event) {
    var toggle = closest(event, ".sidebar-toggle");
    var shell = appShell();
    if (!toggle || !shell) return;
    setSidebarOpen(!shell.classList.contains("sidebar-open"));
  });

  // On the phone the open sidebar overlays the pane, so a tap anywhere outside
  // it (and outside the toggle) closes it, exactly as tapping the toggle does.
  var phone = window.matchMedia("(max-width: 768px)");
  document.addEventListener("click", function (event) {
    var shell = appShell();
    if (!phone.matches || !shell || !shell.classList.contains("sidebar-open")) {
      return;
    }
    if (closest(event, ".sidebar") || closest(event, ".sidebar-toggle")) return;
    setSidebarOpen(false);
  });

  // A swapped reading pane starts at the top and closes the phone sidebar; the
  // tree's highlight follows whatever is open now. htmx 4 puts the swapped
  // element on the request context (`detail.ctx.target`); `event.target` is the
  // element that triggered the request, not the swap target.
  document.addEventListener("htmx:after:swap", function (event) {
    var ctx = event.detail && event.detail.ctx;
    var target = ctx && ctx.target ? ctx.target : event.target;
    if (!target || !target.id) return;
    if (target.id === "note-pane") {
      var pane = document.getElementById("reading-pane");
      if (pane) pane.scrollTop = 0;
      setSidebarOpen(false);
    }
    if (target.id === "note-pane" || target.id === "tree-list") refreshActive();
  });

  // Mark the clicked row immediately, before htmx swaps the pane.
  document.addEventListener("click", function (event) {
    var link = closest(event, "a.tree-file:not(.attachment)");
    if (link) setActive(link);
  });

  // htmx pushes the new URL after the swap, so the highlight is settled here
  // too — this is what clears it when a history entry with no active row comes
  // back (Back/Forward, or a boosted link to a page without a note open). The
  // vault name is a whole-page load, so it never arrives through this path.
  ["htmx:after:history:push", "htmx:after:history:replace"].forEach(
    function (name) {
      document.addEventListener(name, refreshActive);
    },
  );

  // Non-markdown rows that would download ask first. Rows the browser can show
  // as they are (`data-inline`, set from the same list the route uses) keep
  // opening inline, so the two can never disagree.
  document.addEventListener("click", function (event) {
    var link = closest(event, "a.tree-file.attachment:not([data-inline])");
    var dialog = document.getElementById("attach-dialog");
    if (!link || !dialog) return;
    event.preventDefault();
    var kind = link.dataset.type;
    dialog.querySelector(".attach-dialog-type").textContent = kind
      ? kind + " files"
      : "This file";
    dialog
      .querySelector(".attach-dialog-download")
      .setAttribute("href", link.dataset.download || link.href);
    clearTimeout(dialogTimer);
    if (!dialog.open) dialog.showModal();
    dialogTimer = setTimeout(function () {
      dialog.close();
    }, DIALOG_TIMEOUT_MS);
  });

  // Downloading closes the dialog; a backdrop click closes it too, and the
  // pending timer is cleared whenever it closes (`close` does not bubble).
  // The browser retargets a backdrop click to the dialog element, so the click
  // point is what separates it from a click on the dialog's own padding.
  document.addEventListener("click", function (event) {
    var dialog = document.getElementById("attach-dialog");
    if (!dialog) return;
    if (closest(event, ".attach-dialog-download")) {
      dialog.close();
      return;
    }
    if (event.target !== dialog) return;
    var box = dialog.getBoundingClientRect();
    var outside =
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom;
    if (outside) dialog.close();
  });

  document.addEventListener(
    "close",
    function (event) {
      var dialog = document.getElementById("attach-dialog");
      if (dialog && event.target === dialog) clearTimeout(dialogTimer);
    },
    true,
  );

  // Published-page timestamps render in the reader's own timezone as
  // YYYY-MM-DD h:mm AM/PM; the server-rendered text is the UTC fallback.
  document.querySelectorAll("time[data-epoch]").forEach(function (element) {
    var seconds = Number(element.dataset.epoch);
    if (!isFinite(seconds)) return;
    var date = new Date(seconds * 1000);
    var pad = function (value) {
      return String(value).padStart(2, "0");
    };
    var hours = date.getHours();
    element.textContent =
      date.getFullYear() +
      "-" +
      pad(date.getMonth() + 1) +
      "-" +
      pad(date.getDate()) +
      " " +
      (hours % 12 || 12) +
      ":" +
      pad(date.getMinutes()) +
      " " +
      (hours < 12 ? "AM" : "PM");
  });
})();
