/* Progressive enhancement for the site chrome.
   The header and the menu are usable without this file; it adds the shadow on
   scroll, the slide-in panel on narrow screens, and the footer's language
   `<select>` — the banner's language links cover that one when it does not
   run.

   The breakpoint is `header.mobile_view_width` in data/<lang>/header.yaml,
   handed over on <body data-mobile-width>, because CSS media queries cannot
   read a custom property. */
(function () {
    "use strict";

    var body = document.body;
    var header = document.querySelector(".siteheader");
    var toggle = document.getElementById("togglemenu");
    var nav = toggle && document.getElementById(toggle.getAttribute("aria-controls"));
    var width = parseInt(body.getAttribute("data-mobile-width"), 10) || 1100;

    var setMode = function () {
        body.classList.toggle("mobilemenu", window.innerWidth < width);
    };
    setMode();
    window.addEventListener("resize", setMode);

    /* A page's own `transparent_header: true` front matter. The banner is out
       of flow and sits on the hero, so the hero has to reserve the height it
       would have taken. Measured at rest — pinned the banner is shorter,
       having dropped its preheader — and republished on resize, after
       setMode, because the mobile layout is a different height. The
       stylesheet falls back to a fixed 7rem when this file does not run. */
    var transparent = header && header.classList.contains("transparent");
    var setBannerHeight = function () {
        if (!transparent || header.classList.contains("stuck")) return;
        document.documentElement.style.setProperty(
            "--banner-height", header.offsetHeight + "px");
    };
    setBannerHeight();
    window.addEventListener("resize", setBannerHeight);
    window.addEventListener("load", setBannerHeight);

    /* Sticky banner: it scrolls away with the page, then slides back in once
       you are 100px down — the theme's own threshold. A one-pixel sentinel
       parked at document y=100 does the detecting, so there is no scroll
       handler and no per-frame reads of scrollY.

       While pinned the banner is out of flow, so its resting height is
       reserved on <body>. The sentinel is absolutely positioned against the
       initial containing block, so that padding cannot move it and the two
       cannot feed back into each other. */
    if (header && header.classList.contains("sticky")) {
        var sentinel = document.createElement("div");
        sentinel.setAttribute("aria-hidden", "true");
        sentinel.style.cssText =
            "position:absolute;top:100px;left:0;width:1px;height:1px;pointer-events:none";
        body.prepend(sentinel);

        var setStuck = function (stuck) {
            if (stuck === header.classList.contains("stuck")) return;
            /* A transparent banner never was in flow, so pinning it shifts
               nothing and there is no height to reserve. */
            if (!transparent) {
                body.style.paddingBlockStart = stuck ? header.offsetHeight + "px" : "";
            }
            header.classList.toggle("stuck", stuck);
            body.classList.toggle("hasstickyheader", stuck);
        };

        new IntersectionObserver(function (entries) {
            setStuck(!entries[0].isIntersecting);
        }).observe(sentinel);
    }

    /* The language switchers — one in the banner, one in the footer: the
       theme's `<select>` that navigates on change, wired here rather than on
       an inline `onchange`. Their options carry the target url, so picking a
       language lands on this page's translation when there is one.

       They are the one piece of chrome that does not work without this
       file. */
    Array.prototype.forEach.call(
        document.querySelectorAll("[data-languageswitch]"),
        function (select) {
            select.addEventListener("change", function () {
                if (select.value) window.location.href = select.value;
            });
        });

    if (!toggle || !nav) return;

    var setOpen = function (open) {
        toggle.setAttribute("aria-expanded", String(open));
        body.classList.toggle("menushown", open);
    };

    toggle.addEventListener("click", function () {
        setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });

    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
            setOpen(false);
            toggle.focus();
        }
    });

    nav.addEventListener("click", function (event) {
        if (event.target.closest("a")) setOpen(false);
    });

    document.addEventListener("click", function (event) {
        if (!body.classList.contains("menushown")) return;
        if (event.target.closest("#mainnav, #togglemenu")) return;
        setOpen(false);
    });

    /* The listing controls and the blog's paging, ported from the original
       theme's `filter.js`. Each listing shortcode writes its entries' tags onto
       their cards, offers them on a `<select>`, and leaves an empty
       `<ul class="tags">` and a hidden button for this to fill in. A sort
       `<select>` and a search `<input>` ride along when the shortcode asked for
       them.

       A page may carry more than one listing — the shop lists its products and
       its services in turn — so every `form.filter` is wired separately. The
       grid it narrows is the form's next element sibling, which is where the
       shortcodes write it, and the "load more" button, if any, trails that grid.

       Picking a tag narrows rather than replaces: the chosen ones are ANDed,
       so each pick can only shrink the list. That is why an option whose
       addition would empty the page is disabled instead of offered — the
       original theme's `itemsLeft`, which is also where the counts beside each
       tag come from, and why they are counted here rather than in the template:
       they answer "how many are left if I add this one", which changes with
       every pick. The search box narrows the same set on the text each card
       carries (`data-search`), and the sort `<select>` reorders the cards by
       `data-date`, `data-title` or `data-length`. `?tag=name` picks one on
       arrival, so a tag can be linked to.

       Without this file the selects and the search do nothing, the button stays
       hidden and every card is visible: the whole list, unfiltered and unpaged. */
    Array.prototype.forEach.call(document.querySelectorAll("form.filter"), function (filterForm) {
        var postlist = filterForm.nextElementSibling;
        if (!postlist || postlist.tagName !== "UL") return;
        var select = filterForm.querySelector("select.tagfilter");
        var sortSelect = filterForm.querySelector("select.sortfilter");
        var searchInput = filterForm.querySelector("input.searchfilter");
        var pills = filterForm.querySelector("ul.tags");
        var next = postlist.nextElementSibling;
        var more = next && next.classList.contains("loadmore") ? next.querySelector("button") : null;
        var pagesize = parseInt(postlist.getAttribute("data-pagesize"), 10) || 0;
        var numbers = select && select.getAttribute("data-numbers") === "true";
        var cards = Array.prototype.slice.call(postlist.children);
        /* The tag chips on the cards, if the listing carries them: a chip is
           the filter made touchable, so it drives the same `chosen` set. */
        var chips = Array.prototype.slice.call(postlist.querySelectorAll("[data-tag]"));
        var everyTag = select ? Array.prototype.map.call(select.options, function (option) {
            return option.value;
        }).filter(Boolean) : [];
        var chosen = [];
        var query = "";
        var shown = pagesize;

        var carries = function (card, tags) {
            var have = (card.getAttribute("data-tags") || "").split(" ");
            return tags.every(function (tag) { return have.indexOf(tag) !== -1; });
        };
        var queryHit = function (card) {
            if (!query) return true;
            var hay = card.getAttribute("data-search");
            if (hay == null) hay = card.textContent.toLowerCase();
            return hay.indexOf(query) !== -1;
        };
        var matches = function (card, tags) {
            return carries(card, tags) && queryHit(card);
        };
        var countWith = function (tag) {
            return cards.filter(function (card) {
                return matches(card, chosen.concat(tag));
            }).length;
        };

        /* Reorder the cards the sort `<select>` asks for, in place. Appending
           each in turn moves it to the end, so the sorted slice lands in order;
           the counters and the paging then walk the list in that new order.
           Every order falls back to the title so equal keys keep a settled
           order. `date` and `range` are the card's start date and its
           `date`–`enddate` span in seconds, both `data-` attributes the list
           partials write. */
        var sortCards = function () {
            if (!sortSelect || !sortSelect.value) return;
            var mode = sortSelect.value;
            var num = function (card, name) {
                return parseInt(card.getAttribute(name), 10) || 0;
            };
            var ordered = cards.slice();
            ordered.sort(function (a, b) {
                var at = a.getAttribute("data-title") || "";
                var bt = b.getAttribute("data-title") || "";
                var byTitle = at.localeCompare(bt);
                if (mode === "newest" || mode === "oldest") {
                    var diff = num(b, "data-date") - num(a, "data-date");
                    return (mode === "newest" ? diff : -diff) || byTitle;
                }
                if (mode === "longest" || mode === "shortest") {
                    var diffLen = num(b, "data-length") - num(a, "data-length");
                    return (mode === "longest" ? diffLen : -diffLen) || byTitle;
                }
                if (mode === "range" || mode === "range-asc") {
                    var diffRange = num(b, "data-range") - num(a, "data-range");
                    return (mode === "range" ? diffRange : -diffRange) || byTitle;
                }
                return mode === "za" ? -byTitle : byTitle;
            });
            ordered.forEach(function (card) { postlist.append(card); });
        };

        var render = function () {
            /* The cards: the ones carrying every chosen tag and matching the
               search, up to the page, in the order the sort asks for. */
            sortCards();
            var matching = 0;
            Array.prototype.forEach.call(postlist.children, function (card) {
                var hit = matches(card, chosen);
                if (hit) matching += 1;
                card.hidden = !hit || (pagesize > 0 && matching > shown);
            });
            if (more) more.hidden = !(pagesize > 0 && matching > shown);

            /* The select: every tag not already picked, minus the ones that
               would leave nothing. */
            if (select) {
                Array.prototype.forEach.call(select.options, function (option) {
                    if (!option.value) return;
                    var left = countWith(option.value);
                    option.disabled = chosen.indexOf(option.value) !== -1 || left === 0;
                    option.textContent = numbers ? option.value + " (" + left + ")" : option.value;
                });
                select.value = "";
                select.hidden = everyTag.every(function (tag) {
                    return chosen.indexOf(tag) !== -1;
                });
            }

            /* The chips: one per chosen tag, each a button that drops it. */
            if (pills) {
                pills.textContent = "";
                chosen.forEach(function (tag) {
                    var item = document.createElement("li");
                    var drop = document.createElement("button");
                    drop.type = "button";
                    drop.textContent = tag;
                    drop.setAttribute("aria-label", (select ? select.getAttribute("data-label-stop") : "Stop filtering on") + " " + tag);
                    drop.addEventListener("click", function () {
                        chosen = chosen.filter(function (name) { return name !== tag; });
                        shown = pagesize;
                        render();
                    });
                    item.append(drop);
                    pills.append(item);
                });
            }

            /* Each chip on the cards shows whether its tag is in the filter. */
            chips.forEach(function (chip) {
                chip.setAttribute("aria-pressed", chosen.indexOf(chip.getAttribute("data-tag")) !== -1 ? "true" : "false");
            });
        };

        /* A chip toggles its own tag: on the first click it joins the filter,
           on the next it leaves, so a tag can be followed from the card it sits
           on as well as from the `<select>`. */
        chips.forEach(function (chip) {
            chip.addEventListener("click", function () {
                var tag = chip.getAttribute("data-tag");
                chosen = chosen.indexOf(tag) === -1
                    ? chosen.concat(tag)
                    : chosen.filter(function (name) { return name !== tag; });
                shown = pagesize;
                render();
            });
        });

        if (select) {
            select.addEventListener("change", function () {
                if (!select.value) return;
                chosen = chosen.concat(select.value);
                shown = pagesize;
                render();
            });
        }
        if (sortSelect) {
            sortSelect.addEventListener("change", function () {
                shown = pagesize;
                render();
            });
        }
        if (searchInput) {
            searchInput.addEventListener("input", function () {
                query = searchInput.value.trim().toLowerCase();
                shown = pagesize;
                render();
            });
        }
        if (more) {
            more.addEventListener("click", function () {
                shown += pagesize;
                render();
            });
        }

        var wanted = new URLSearchParams(window.location.search).get("tag");
        if (wanted && everyTag.indexOf(wanted) !== -1) chosen = [wanted];
        render();
    });

    /* -- tabs ----------------------------------------------------------
       The `tabs` shortcode. The markup is complete without this file — the
       panels stack under their own headings and the tablist stays hidden.
       Wiring it marks the widget `ready`, which is what shows the tablist
       and collapses the stack to the selected panel. Arrow keys move along
       the tabs with the roving tabindex the ARIA pattern asks for. */
    Array.prototype.forEach.call(document.querySelectorAll(".tabs"), function (widget) {
        var tabs = widget.querySelectorAll("[role='tab']");
        var panels = widget.querySelectorAll("[role='tabpanel']");
        if (!tabs.length || tabs.length !== panels.length) return;

        var select = function (chosen) {
            Array.prototype.forEach.call(tabs, function (tab, i) {
                tab.setAttribute("aria-selected", i === chosen ? "true" : "false");
                tab.tabIndex = i === chosen ? 0 : -1;
                panels[i].hidden = i !== chosen;
            });
        };

        Array.prototype.forEach.call(tabs, function (tab, i) {
            tab.addEventListener("click", function () { select(i); });
            tab.addEventListener("keydown", function (event) {
                var to = -1;
                if (event.key === "ArrowRight") to = (i + 1) % tabs.length;
                if (event.key === "ArrowLeft") to = (i - 1 + tabs.length) % tabs.length;
                if (event.key === "Home") to = 0;
                if (event.key === "End") to = tabs.length - 1;
                if (to === -1) return;
                event.preventDefault();
                select(to);
                tabs[to].focus();
            });
        });

        select(0);
        widget.classList.add("ready");
    });
})();
