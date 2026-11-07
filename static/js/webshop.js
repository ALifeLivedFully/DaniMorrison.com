/* The webshop, ported from the original theme's webshop.js and rewritten in
   the house style: one IIFE, listeners instead of inline handlers, the DOM
   built with elements rather than markup strings.

   The state is client-side: localStorage holds "cart" (the line items, one
   per sku), "addons" (the checkout's priced extras) and "ordernumber" — the
   same keys and shapes as the original theme, so a stored cart survives the
   migration. Prices, links and the currency symbol ride into the page as
   data- attributes that the bricks and the checkout shortcode write from
   data/<lang>/webshop.yaml, so this file carries no configuration.

   Without this file the shop is a brochure: every page still renders, the
   cart shows its honest "empty" row, and the checkout posts a complete
   address whose order lines stay blank. The banner's cart count rests
   hidden, which is also its no-javascript state. */
(function () {
    "use strict";

    /* localStorage can be absent or refuse (private windows, sandboxes);
       a shop that cannot remember is the same shop as one with no script. */
    var read = function (key) {
        try { return JSON.parse(localStorage.getItem(key)) || []; }
        catch (error) { return []; }
    };
    var write = function (key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); }
        catch (error) { /* nothing to do — the page keeps working stateless */ }
    };
    var stored = function (key) {
        try { return localStorage.getItem(key); }
        catch (error) { return null; }
    };

    var cartTotal = function () {
        return read("cart").reduce(function (sum, item) {
            return sum + item.quantity * parseFloat(item.price);
        }, 0);
    };
    var addonTotal = function () {
        return read("addons").reduce(function (sum, addon) {
            return sum + parseFloat(addon.price);
        }, 0);
    };
    /* The language's money format rides on the section as data- attributes,       written by the bricks from data/<lang>/webshop.yaml: the symbol, whether
       it leads or trails the number, and whether a space sits between them.
       Reading them once per section keeps the redraws from re-parsing. */
    var currency = function (el) {
        return {
            symbol: (el && el.getAttribute("data-currency")) || "",
            suffix: el && el.getAttribute("data-currency-position") === "suffix",
            space: el && el.getAttribute("data-currency-space") === "true"
        };
    };
    /* The number itself, localised the way Hugo's `lang.FormatNumber` writes
       it server-side — same decimal mark, same grouping — so a price redrawn
       here does not disagree with the price in the markup it replaces. The
       page's `<html lang>` is the locale. If `Intl` is missing or the tag is
       one it refuses, the plain dot form is what there is; a shop that shows
       9.95 where the page shows 9,95 is still a shop. */
    var number = function (n) {
        try {
            return new Intl.NumberFormat(document.documentElement.lang,
                { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
        } catch (error) {
            return n.toFixed(2);
        }
    };
    var formatMoney = function (c, amount) {
        var text = number(amount);
        if (c.suffix) return text + (c.space ? " " : "") + c.symbol;
        return c.symbol + (c.space ? " " : "") + text;
    };
    var capitalize = function (text) {
        return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
    };
    /* The banner's cart count — an <output aria-live> that rests hidden, so
       an empty cart announces nothing. On every page. */
    var updateCount = function () {
        var count = read("cart").reduce(function (sum, item) {
            return sum + item.quantity;
        }, 0);
        Array.prototype.forEach.call(document.querySelectorAll(".itemcount"), function (out) {
            out.textContent = count;
            out.hidden = count === 0;
        });
    };
    updateCount();

    /* -- the product page: the add-to-cart form ---------------------------
       The form and its options carry everything as data- attributes; picking
       a variant rewrites the price beside the title, submitting puts the
       variant in the cart and moves on to it. */
    var productForm = document.querySelector("section.product form[data-cart-link]");
    if (productForm) {
        var variants = productForm.querySelector("select");
        var chosen = function () { return variants.options[variants.selectedIndex]; };

        variants.addEventListener("change", function () {
            var price = parseFloat(chosen().getAttribute("data-price"));
            Array.prototype.forEach.call(document.querySelectorAll(".productprice"), function (el) {
                el.textContent = number(price);
            });
        });

        productForm.addEventListener("submit", function (event) {
            event.preventDefault();
            var cart = read("cart");
            var option = chosen();
            var sku = option.getAttribute("data-sku");
            var line = cart.filter(function (item) { return item.sku === sku; })[0];
            if (line) line.quantity += 1;
            else cart.push({
                url: productForm.getAttribute("data-url"),
                sku: sku,
                title: productForm.getAttribute("data-title"),
                varianttype: productForm.getAttribute("data-varianttype"),
                variantname: option.getAttribute("data-variantname"),
                price: option.getAttribute("data-price"),
                image: productForm.getAttribute("data-image"),
                quantity: 1
            });
            write("cart", cart);
            window.location.href = productForm.getAttribute("data-cart-link");
        });
    }

    /* -- the cart page -----------------------------------------------------
       The markdown wrote the table with its "cart is empty" row; that row is
       kept as the empty state and the body is redrawn from storage, one line
       per item just as the page's own markup writes them. Setting an amount
       to 0 removes the line — the `min="0"` on the amount field is the way
       out of the cart. */
    var cartSection = document.querySelector("section.cart");
    var cartBody = cartSection && cartSection.querySelector("table tbody");
    if (cartBody) {
        var cartCurrency = currency(cartSection);
        var emptyRow = cartBody.innerHTML;

        var redraw = function () {
            var cart = read("cart");
            cartBody.textContent = "";
            if (!cart.length) cartBody.innerHTML = emptyRow;

            cart.forEach(function (item) {
                var row = document.createElement("tr");
                var cell = function () {
                    return row.appendChild(document.createElement("td"));
                };

                /* The avatar and the product cell both lead back to the
                   product page, avatar and text each wrapped whole. The
                   avatar's link is named by the image's alt — without it the
                   link is an unlabelled tab stop. */
                var avatar = document.createElement("img");
                avatar.className = "productavatar";
                avatar.src = item.image;
                avatar.alt = item.title;
                avatar.width = 64;
                avatar.height = 64;
                var avatarLink = document.createElement("a");
                avatarLink.href = item.url;
                avatarLink.append(avatar);
                cell().append(avatarLink);

                /* The product cell, as the original theme writes it: the
                   title, the variant and the price of one, stacked. */
                var product = document.createElement("a");
                product.href = item.url;
                product.textContent = item.title;
                if (item.varianttype) {
                    product.append(document.createElement("br"),
                        capitalize(item.varianttype) + ": " + item.variantname);
                }
                product.append(document.createElement("br"),
                    formatMoney(cartCurrency, parseFloat(item.price)));
                cell().append(product);

                var label = document.createElement("label");
                label.className = "sr-only";
                label.htmlFor = "amount-" + item.sku;
                label.textContent = (cartSection.getAttribute("data-label-amount") || "Amount") + ": " + item.title;
                var amount = document.createElement("input");
                amount.id = "amount-" + item.sku;
                amount.type = "number";
                amount.min = "0";
                amount.value = item.quantity;
                amount.addEventListener("change", function () {
                    requantify(item.sku, parseInt(amount.value, 10) || 0);
                });
                cell().append(label, amount);

                cell().textContent = formatMoney(cartCurrency, item.quantity * parseFloat(item.price));

                cartBody.append(row);
            });

            Array.prototype.forEach.call(cartSection.querySelectorAll(".carttotal"), function (el) {
                el.textContent = formatMoney(cartCurrency, cartTotal());
            });
            updateCount();
        };

        var drop = function (sku) {
            write("cart", read("cart").filter(function (item) { return item.sku !== sku; }));
            redraw();
        };
        var requantify = function (sku, quantity) {
            if (quantity < 1) return drop(sku);
            var cart = read("cart");
            cart.forEach(function (item) {
                if (item.sku === sku) item.quantity = quantity;
            });
            write("cart", cart);
            redraw();
        };

        redraw();
    }

    /* -- the checkout page ---------------------------------------------------
       The shortcode wrote the form; this fills its hidden inputs — `order`
       with the cart's sku and quantity lines, `checkout` with the totals,
       `ordernumber` on submit — and keeps the summary beside it true to what
       is chosen: every control with a data-price is an extra to be summed. */
    var checkout = document.getElementById("checkoutform");
    if (checkout) {
        var checkoutCurrency = currency(checkout);
        var calculation = document.querySelector("section.checkout .calculation");
        var emailInput = checkout.querySelector("input[name='email']");
        var savedEmail = stored("email");
        if (emailInput && !emailInput.value && savedEmail) emailInput.value = savedEmail;

        checkout.querySelector("input[name='order']").value =
            JSON.stringify(read("cart").map(function (item) {
                return { sku: item.sku, quantity: item.quantity };
            }));

        var refresh = function () {
            /* The priced extras as chosen right now: the selects with a
               choice made, and any checked control carrying a price. A free
               option is a fact about the order, not a line on the bill, so
               zero prices stay off the summary — except on a select marked
               `data-always` (shipping), where which one was picked is the
               news even when it costs nothing. */
            var addons = [];
            Array.prototype.forEach.call(
                checkout.querySelectorAll("input[data-price]:checked"),
                function (input) {
                    if (parseFloat(input.getAttribute("data-price"))) addons.push({
                        title: input.getAttribute("data-title"),
                        group: input.getAttribute("data-group") || input.getAttribute("data-title"),
                        value: input.value,
                        price: input.getAttribute("data-price")
                    });
                });
            Array.prototype.forEach.call(checkout.querySelectorAll("select"), function (select) {
                var option = select.options[select.selectedIndex];
                if (!select.value || !option || !option.hasAttribute("data-price")) return;
                if (parseFloat(option.getAttribute("data-price")) || select.hasAttribute("data-always")) addons.push({
                    title: option.getAttribute("data-title"),
                    group: option.getAttribute("data-group") || option.getAttribute("data-title"),
                    value: option.value,
                    price: option.getAttribute("data-price")
                });
            });
            write("addons", addons);

            /* The summary, redrawn: cart, extras, total. */
            var lines = [[(checkout.getAttribute("data-label-cart") || "Shopping cart") + ":", cartTotal()]];
            addons.forEach(function (addon) {
                lines.push([addon.title + ":", parseFloat(addon.price)]);
            });
            lines.push([(checkout.getAttribute("data-label-total") || "Payment total") + ":", cartTotal() + addonTotal()]);

            if (calculation) {
                calculation.textContent = "";
                lines.forEach(function (line, index) {
                    var last = index === lines.length - 1;
                    var name = document.createElement("span");
                    name.textContent = line[0];
                    var value = formatMoney(checkoutCurrency, line[1]);
                    if (last) {
                        /* The sum is one block-level line of its own, so its
                           top border rules across the whole summary. */
                        var sum = document.createElement("span");
                        sum.className = "sum";
                        var strong = document.createElement("strong");
                        strong.textContent = value;
                        sum.append(name, " ", strong);
                        calculation.append(sum);
                    } else {
                        if (index) calculation.append(document.createElement("br"));
                        calculation.append(name, " ", value);
                    }
                });
            }

            checkout.querySelector("input[name='checkout']").value =
                lines.map(function (line) {
                    return line[0] + " " + formatMoney(checkoutCurrency, line[1]);
                }).join(" | ");
        };

        checkout.addEventListener("change", refresh);
        refresh();

        /* Picking Dutch shipping fills in the country, as the original theme
           did; any other choice clears it again for the buyer to say. */
        var shipping = checkout.querySelector("select[name='shipping']");
        var country = checkout.querySelector("input[name='country']");
        if (shipping && country) shipping.addEventListener("change", function () {
            country.value = shipping.value === "Shipping NL" ? "The Netherlands" : "";
        });

        /* The order is submitted as structured JSON: the line items are sku
           and quantity only, and the worker checks those against the shop
           catalog, prices the shipping and options, and records whether the
           order validated. The visitor only moves to the payment page when
           the worker says the order is valid; without fetch the plain form
           still posts, and the worker answers with the same validation. */
        var errorBox = checkout.querySelector(".checkout-error");
        var submitButton = checkout.querySelector("button[type='submit']");
        var showError = function (message) {
            if (!errorBox) return;
            errorBox.textContent = message;
            errorBox.hidden = false;
        };
        var fieldValue = function (name) {
            var field = checkout.querySelector("[name='" + name + "']");
            return field ? String(field.value || "").trim() : "";
        };

        checkout.addEventListener("submit", function (event) {
            var ordernumber = Math.round(Date.now() / 100) % 6307200000;
            checkout.querySelector("input[name='ordernumber']").value = ordernumber;
            write("ordernumber", ordernumber);
            if (emailInput) {
                try { localStorage.setItem("email", emailInput.value.trim()); }
                catch (error) { /* storage is optional */ }
            }

            var items = read("cart").filter(function (item) {
                return item.sku;
            }).map(function (item) {
                return { sku: item.sku, quantity: item.quantity };
            });
            var addons = [];
            Array.prototype.forEach.call(checkout.querySelectorAll("select[name]"), function (select) {
                if (select.name === "shipping" || !select.value) return;
                var option = select.options[select.selectedIndex];
                if (!option) return;
                addons.push({
                    group: select.getAttribute("data-group") ||
                        option.getAttribute("data-group") ||
                        option.getAttribute("data-title") || select.name,
                    value: select.value
                });
            });
            Array.prototype.forEach.call(
                checkout.querySelectorAll("input[data-price]:checked"),
                function (input) {
                    addons.push({
                        group: input.getAttribute("data-group") || input.getAttribute("data-title"),
                        value: input.value
                    });
                });

            var shipping = checkout.querySelector("select[name='shipping']");
            var payload = {
                schema_version: 1,
                shop_id: fieldValue("shop_id"),
                ordernumber: String(ordernumber),
                customer: {
                    firstname: fieldValue("firstname"),
                    lastname: fieldValue("lastname"),
                    email: fieldValue("email"),
                    address: fieldValue("address"),
                    zipcode: fieldValue("zipcode"),
                    city: fieldValue("city"),
                    country: fieldValue("country")
                },
                items: items,
                shipping: shipping ? { title: shipping.value } : null,
                addons: addons,
                message: fieldValue("message"),
                currency: checkout.getAttribute("data-currency-code") || "",
                _next: fieldValue("_next") || "/payment/"
            };

            checkout.querySelector("input[name='order']").value = JSON.stringify(items);

            var paymentlink = checkout.getAttribute("data-payment-link");
            if (!paymentlink || !window.fetch) return;
            event.preventDefault();
            if (errorBox) {
                errorBox.hidden = true;
                errorBox.textContent = "";
            }
            if (submitButton) submitButton.disabled = true;

            fetch(checkout.action, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                mode: "cors",
                keepalive: true
            }).then(function (response) {
                return response.text().then(function (body) {
                    var result = {};
                    try { result = JSON.parse(body); }
                    catch (error) { result = { error: body }; }
                    return { ok: response.ok, status: response.status, result: result };
                });
            }).then(function (outcome) {
                if (!outcome.ok || !outcome.result.success) {
                    if (submitButton) submitButton.disabled = false;
                    var messages = (outcome.result.checks || [])
                        .filter(function (check) { return !check.passed; })
                        .map(function (check) { return check.message; });
                    var detail = outcome.result.error;
                    if (typeof detail !== "string" || /<[^>]*>/.test(detail)) detail = "";
                    var fallback = detail ||
                        "We could not validate this order. Please check your details and try again.";
                    showError(messages.length
                        ? messages.join(" ")
                        : (outcome.status ? fallback + " (" + outcome.status + ")" : fallback));
                    return;
                }
                window.location.href = paymentlink;
            }).catch(function () {
                if (submitButton) submitButton.disabled = false;
                showError("We could not reach the order service. Please try again.");
            });
        });
    }

    /* -- the payment page ------------------------------------------------- */
    var paymentTotal = document.getElementById("paymenttotal");
    if (paymentTotal) {
        var paymentSection = paymentTotal.closest("section.payment");
        paymentTotal.textContent = formatMoney(currency(paymentSection), cartTotal() + addonTotal());
    }

})();
