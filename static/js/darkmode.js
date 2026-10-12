/* The dark mode switch — data/settings.yaml `enable_darkmode`.

   The head of the document applies the theme before first paint (see
   `baseof.html`), so there is no flash of the wrong palette; this file only
   handles the banner's toggle and keeps the two in step.

   The choice lives in `localStorage` under `theme` and beats the system one.
   When nothing is stored the site follows `prefers-color-scheme`, so a
   visitor who has set their OS to dark gets dark without ever finding the
   button — and one click pins the opposite. The `storage` listener carries
   a click in one tab to every other tab on the same origin. */
(function () {
    "use strict";

    var root = document.documentElement;
    var toggle = document.getElementById("themetoggle");
    if (!toggle) return;

    var apply = function (theme) {
        root.setAttribute("data-theme", theme);
        toggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    };

    /* The head script already set `data-theme`; this only catches the button
       up with it, and the theme itself if that script was blocked. */
    apply(root.getAttribute("data-theme") ||
        (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

    toggle.addEventListener("click", function () {
        var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
        try { localStorage.setItem("theme", next); } catch (error) { /* private mode */ }
        apply(next);
    });

    window.addEventListener("storage", function (event) {
        if (event.key === "theme" && (event.newValue === "dark" || event.newValue === "light")) {
            apply(event.newValue);
        }
    });
})();
