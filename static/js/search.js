/* Client-side search for the `search` shortcode — data/settings.yaml
   `enable_search`.

   There is no service behind this. The form on `/search/` points at the
   JSON index Hugo renders for the current language
   (`layouts/home.searchindex.json`); this file fetches it once, on the
   first keystroke, and filters it in the browser from then on.

   Matching is deliberately plain: every word in the box has to appear
   somewhere in the page, a hit in the title counts for more than a hit in
   the body, and the best twenty come back in order. The excerpt starts
   just before the first hit, so the line under each title shows *why* the
   page matched instead of the first two sentences of everything. */
(function () {
    "use strict";

    var form = document.querySelector("[data-search]");
    if (!form) return;

    var input = form.querySelector("input[type='search']");
    var list = form.querySelector("[data-results]");
    var none = form.getAttribute("data-none") || "No results";
    var index = null;   // the fetched index, as a promise
    var run = 0;        // the request the list is currently showing

    var load = function () {
        if (!index) {
            index = fetch(form.getAttribute("data-index"))
                .then(function (response) { return response.json(); })
                .catch(function () { return []; });
        }
        return index;
    };

    var literal = function (text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    };

    /* 0 for a miss — and a miss on any one word loses the page, so that
       "web stack" finds nothing about a stack of bricks — otherwise the
       title's say over the body's, plus the whole phrase as typed. A page's
       tags count too (between title and body), so a tag link — which searches
       the tag — finds every page labelled with it. */
    var score = function (page, words) {
        var title = (page.title || "").toLowerCase();
        var tags = " " + (page.tags || "").toLowerCase() + " ";
        var body = (page.text || "").toLowerCase();
        var points = 0;
        for (var i = 0; i < words.length; i++) {
            var inTitle = title.indexOf(words[i]) !== -1;
            var inTags = tags.indexOf(words[i]) !== -1;
            if (!inTitle && !inTags && body.indexOf(words[i]) === -1) return 0;
            points += inTitle ? 5 : inTags ? 3 : 1;
        }
        if (title.indexOf(words.join(" ")) === 0) points += 4;
        return points;
    };

    var excerpt = function (page, words) {
        var text = page.text || "";
        var hay = text.toLowerCase();
        var at = -1;
        for (var i = 0; i < words.length; i++) {
            var hit = hay.indexOf(words[i]);
            if (hit !== -1 && (at === -1 || hit < at)) at = hit;
        }
        if (at === -1) return text.slice(0, 200);
        var from = Math.max(0, at - 40);
        var to = Math.min(text.length, at + 160);
        return (from ? "…" : "") + text.slice(from, to).trim() + (to < text.length ? "…" : "");
    };

    /* The excerpt as nodes, the hits on it wrapped in `<mark>`. Built node
       by node rather than assembled into a string: the index is this site's
       own, but content is content and should not be trusted as markup. */
    var annotate = function (into, text, words) {
        var pattern = new RegExp("(" + words.map(literal).join("|") + ")", "gi");
        text.split(pattern).forEach(function (piece, i) {
            if (!piece) return;
            if (i % 2) {
                var mark = document.createElement("mark");
                mark.textContent = piece;
                into.append(mark);
            } else {
                into.append(document.createTextNode(piece));
            }
        });
    };

    var render = function (pages, words) {
        list.textContent = "";
        if (!pages.length) {
            var empty = document.createElement("li");
            empty.className = "none";
            empty.textContent = none;
            list.append(empty);
            return;
        }
        pages.forEach(function (page) {
            var item = document.createElement("li");
            var link = document.createElement("a");
            link.href = page.url;
            var title = document.createElement("span");
            title.className = "title";
            title.textContent = page.title;
            var body = document.createElement("span");
            body.className = "excerpt";
            annotate(body, excerpt(page, words), words);
            link.append(title, body);
            item.append(link);
            list.append(item);
        });
    };

    var search = function (query) {
        var words = query.toLowerCase().split(/\s+/).filter(Boolean);
        var wanted = ++run;
        if (!words.length) { list.textContent = ""; return; }
        load().then(function (pages) {
            if (wanted !== run) return;   // a later keystroke won the race
            var hits = [];
            pages.forEach(function (page) {
                var points = score(page, words);
                if (points) hits.push({ page: page, points: points });
            });
            hits.sort(function (a, b) { return b.points - a.points; });
            render(hits.slice(0, 20).map(function (hit) { return hit.page; }), words);
        });
    };

    var timer = null;
    input.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(function () { search(input.value); }, 120);
    });
    form.addEventListener("submit", function (event) {
        event.preventDefault();
        clearTimeout(timer);
        search(input.value);
    });

    /* `/search/?q=…` arrives already answered — and sets the field, which is
       what a link to a search result page should do. */
    var wanted = new URLSearchParams(window.location.search).get("q");
    if (wanted) {
        input.value = wanted;
        search(wanted);
    }
})();
