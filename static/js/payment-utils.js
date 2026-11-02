/* Small, pure helpers around a resolved conversion.
 *
 * The exchange-rate resolver owns fetching, validation and arithmetic; these
 * helpers only turn one resolved conversion into a provider URL or a bank QR
 * payload. Keeping them here means the amount in a link, in a QR code and on
 * the page is derived from the same conversion object exactly once.
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.PaymentUtils = factory();
    }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function formatTemplate(template, data) {
        if (!template) return "";
        data = data || {};
        return String(template)
            .replace(/\{address\}/g, data.address || "")
            .replace(/\{amount\}/g, data.amount == null ? "" : data.amount)
            .replace(/\{order\}/g, data.order ? encodeURIComponent("Order " + data.order) : "")
            .replace(/\{ordernumber\}/g, data.order ? encodeURIComponent(data.order) : "")
            .replace(/\$\{username\}/g, data.username || "")
            .replace(/\{username\}/g, data.username || "");
    }

    function linkCurrency(link, shop) {
        var currency = link && link.currency ? link.currency : shop;
        return String(currency || "USD").trim().toUpperCase();
    }

    /* Fiat providers expect a conventional decimal amount; crypto URIs are
       happier without trailing zeroes beyond the coin's precision. Both come
       from the same rounded conversion. */
    function paymentAmount(conversion) {
        if (!conversion) return "";
        return conversion.isCrypto ? conversion.amount : conversion.formattedAmount;
    }

    function displayAmount(conversion) {
        if (!conversion) return "";
        var amount = conversion.isCrypto ? conversion.amount : conversion.formattedAmount;
        return amount + (conversion.currency ? " " + conversion.currency : "");
    }

    function buildPaymentUrl(link, conversion, order) {
        if (!link) return "";
        var template = link.template || link.url || "";
        if (!template) return "";
        var amount = paymentAmount(conversion);
        return formatTemplate(template, {
            username: link.username || "",
            amount: amount,
            order: order || "",
            address: link.address || ""
        });
    }

    function ensApiUrl(template, name) {
        template = template || "https://api.ensdata.net/{name}";
        return String(template).replace(/\{name\}/g, encodeURIComponent(name || ""));
    }

    function ensAddress(wallets, coin) {
        if (!wallets || !coin) return "";
        var address = wallets[String(coin).toLowerCase()];
        return typeof address === "string" ? address.trim() : "";
    }

    function buildEpcPayload(options) {
        options = options || {};
        var bic = String(options.bic || "").replace(/\s/g, "");
        var name = String(options.name || "");
        var iban = String(options.iban || "").replace(/\s/g, "");
        var currency = String(options.currency || "EUR").trim().toUpperCase();
        var include = options.includeAmount !== false;
        var amount = include && options.amount ? currency + options.amount : "";
        return [
            "BCD",
            "002",
            "1",
            "SCT",
            bic,
            name,
            iban,
            amount,
            "",
            "",
            options.reference || ""
        ].join("\n");
    }

    return {
        formatTemplate: formatTemplate,
        linkCurrency: linkCurrency,
        paymentAmount: paymentAmount,
        displayAmount: displayAmount,
        buildPaymentUrl: buildPaymentUrl,
        buildEpcPayload: buildEpcPayload,
        ensApiUrl: ensApiUrl,
        ensAddress: ensAddress
    };
}));
