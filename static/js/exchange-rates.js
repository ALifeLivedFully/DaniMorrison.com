/* Exchange-rate resolver for the static shop.
 *
 * One code path resolves fiat and cryptocurrency rates: read the currency
 * configuration, use a valid cached (or build-prefetched) rate, fetch an API
 * when the mode allows it, extract the configured JSON path, invert when asked,
 * validate, cache, and fall back to a fixed rate where that is configured.
 *
 * All resolved rates mean "units of target currency per 1 shop-currency unit".
 * Monetary arithmetic is done with scaled BigInt decimals; ordinary floating
 * point is never used for a conversion. The module runs in the browser and in
 * Node (for tests), with no dependency.
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory(root);
    } else {
        root.ExchangeRates = factory(root);
    }
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
    "use strict";

    var VERSION = "1.0.0";
    var DEFAULT_CACHE_TTL = 3600;
    var DEFAULT_CRYPTO_CACHE_TTL = 300;
    var DEFAULT_DECIMALS = 2;
    var DEFAULT_CRYPTO_DECIMALS = 8;
    var MAX_INVERT_SCALE = 30;
    var CACHE_PREFIX = "exchange_rate:";

    function ExchangeRateError(code, message, cause) {
        var error = new Error(message);
        error.name = "ExchangeRateError";
        error.code = code;
        if (cause) error.cause = cause;
        return error;
    }

    function upper(value) {
        return String(value == null ? "" : value).trim().toUpperCase();
    }

    function lower(value) {
        return String(value == null ? "" : value).trim().toLowerCase();
    }

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function boolValue(value, fallback) {
        if (value === true || value === "true" || value === 1 || value === "1") return true;
        if (value === false || value === "false" || value === 0 || value === "0") return false;
        return fallback;
    }

    function intValue(value, fallback, minimum, maximum) {
        var number = Number(value);
        if (!isFinite(number)) return fallback;
        number = Math.floor(number);
        if (number < minimum) return fallback;
        if (maximum != null && number > maximum) return fallback;
        return number;
    }

    function positiveSeconds(value, fallback) {
        var number = Number(value);
        if (!isFinite(number) || number <= 0) return fallback;
        return number;
    }

    /* -- decimal arithmetic -------------------------------------------------
       A decimal is { sign: 1|-1, digits: BigInt (absolute), scale: int }.
       The value is sign * digits / 10^scale. */
    var DECIMAL_PATTERN = /^([+-])?((?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE]([+-]?\d+))?$/;

    function parseDecimal(value) {
        if (typeof value === "bigint") value = value.toString();
        if (typeof value === "number") {
            if (!isFinite(value)) return null;
            value = String(value);
        }
        if (typeof value !== "string") return null;
        var text = value.trim();
        if (!text) return null;
        var match = DECIMAL_PATTERN.exec(text);
        if (!match) return null;

        var sign = match[1] === "-" ? -1 : 1;
        var mantissa = match[2];
        var exponent = match[3] == null ? 0 : parseInt(match[3], 10);
        var point = mantissa.indexOf(".");
        var digitsText;
        var scale;

        if (point === -1) {
            digitsText = mantissa;
            scale = 0;
        } else {
            digitsText = mantissa.slice(0, point) + mantissa.slice(point + 1);
            scale = mantissa.length - point - 1;
        }
        scale -= exponent;
        if (scale < 0) {
            digitsText += new Array(-scale + 1).join("0");
            scale = 0;
        }

        digitsText = digitsText.replace(/^0+(?=\d)/, "");
        if (!digitsText) digitsText = "0";
        var digits = BigInt(digitsText);
        if (digits === BigInt(0)) sign = 1;

        return { sign: sign, digits: digits, scale: scale };
    }

    function pow10(exponent) {
        return BigInt(10) ** BigInt(exponent);
    }

    function alignDigits(decimal, targetScale) {
        return decimal.digits * pow10(targetScale - decimal.scale);
    }

    function canonicalDecimal(decimal, fixedScale) {
        var scale = fixedScale == null ? decimal.scale : fixedScale;
        var digits = decimal.digits;
        if (decimal.scale < scale) {
            digits *= pow10(scale - decimal.scale);
        } else if (decimal.scale > scale) {
            digits = roundDigits(digits, decimal.scale - scale, decimal.sign, "half-up");
        }

        var text = digits.toString();
        if (scale > 0) {
            while (text.length < scale + 1) text = "0" + text;
            text = text.slice(0, text.length - scale) + "." + text.slice(text.length - scale);
        }
        if (fixedScale == null && scale > 0) {
            text = text.replace(/0+$/, "").replace(/\.$/, "");
        }
        if (text === "" || text === "0") return decimal.sign < 0 && digits !== BigInt(0) ? "-0" : "0";
        return (decimal.sign < 0 ? "-" : "") + text;
    }

    function roundDigits(digits, drop, sign, mode) {
        if (drop <= 0) return digits * pow10(-drop);
        var factor = pow10(drop);
        var quotient = digits / factor;
        var remainder = digits % factor;
        if (remainder === BigInt(0)) return quotient;

        if (mode === "ceil") {
            if (sign > 0) quotient += BigInt(1);
        } else if (mode === "floor") {
            if (sign < 0) quotient += BigInt(1);
        } else if (mode === "truncate") {
            /* leave it */
        } else {
            /* half-up, away from zero at the midpoint */
            if (remainder * BigInt(2) >= factor) quotient += BigInt(1);
        }
        return quotient;
    }

    function roundDecimal(decimal, targetScale, mode) {
        var result = { sign: decimal.sign, digits: decimal.digits, scale: decimal.scale };
        if (decimal.scale > targetScale) {
            result.digits = roundDigits(decimal.digits, decimal.scale - targetScale, decimal.sign, mode || "half-up");
            result.scale = targetScale;
        } else if (decimal.scale < targetScale) {
            result.digits = decimal.digits * pow10(targetScale - decimal.scale);
            result.scale = targetScale;
        }
        if (result.digits === BigInt(0)) result.sign = 1;
        return result;
    }

    function multiplyDecimal(a, b) {
        return { sign: a.sign * b.sign, digits: a.digits * b.digits, scale: a.scale + b.scale };
    }

    function divideDecimal(a, b, resultScale) {
        if (b.digits === BigInt(0)) return null;
        var exponent = b.scale + resultScale - a.scale;
        var numerator = a.digits;
        var denominator = b.digits;
        if (exponent >= 0) {
            numerator *= pow10(exponent);
        } else {
            denominator *= pow10(-exponent);
        }
        var quotient = numerator / denominator;
        var remainder = numerator % denominator;
        if (remainder * BigInt(2) >= denominator) quotient += BigInt(1);
        return { sign: a.sign * b.sign, digits: quotient, scale: resultScale };
    }

    function positiveDecimal(value) {
        var decimal = parseDecimal(value);
        if (!decimal || decimal.sign < 0 || decimal.digits === BigInt(0)) return null;
        return decimal;
    }

    function addAmounts(values) {
        var decimals = [];
        (values || []).forEach(function (value) {
            var decimal = parseDecimal(value);
            if (decimal) decimals.push(decimal);
        });
        if (!decimals.length) return "0";
        var scale = decimals.reduce(function (max, item) {
            return Math.max(max, item.scale);
        }, 0);
        var total = decimals.reduce(function (sum, item) {
            var signed = alignDigits(item, scale);
            return sum + (item.sign < 0 ? -signed : signed);
        }, BigInt(0));
        if (total === BigInt(0)) return "0";
        return canonicalDecimal({
            sign: total < BigInt(0) ? -1 : 1,
            digits: total < BigInt(0) ? -total : total,
            scale: scale
        });
    }

    function multiplyAmount(value, quantity) {
        var amount = parseDecimal(value);
        var count = parseDecimal(quantity);
        if (!amount || !count) return null;
        return canonicalDecimal(multiplyDecimal(amount, count));
    }

    function formatAmount(value, decimals, options) {
        var decimal = parseDecimal(value);
        if (!decimal) return null;
        options = options || {};
        var places = intValue(decimals, DEFAULT_DECIMALS, 0, 36);
        var rounded = roundDecimal(decimal, places, options.rounding || "half-up");
        return canonicalDecimal(rounded, options.trim === true ? null : places);
    }

    /* -- JSON path extraction ---------------------------------------------- */
    function extractJsonPath(data, path) {
        if (path == null || String(path).trim() === "") return data;
        var segments = String(path).split(".");
        var cursor = data;
        for (var i = 0; i < segments.length; i += 1) {
            var segment = segments[i];
            if (cursor === null || cursor === undefined) return undefined;
            if (typeof cursor !== "object") return undefined;
            if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
            cursor = cursor[segment];
        }
        return cursor;
    }

    /* -- configuration ------------------------------------------------------ */
    function currencyObject(config) {
        if (config && typeof config === "object" && config.currency &&
            typeof config.currency === "object" &&
            (config.currency.shop || config.currency.supported || config.currency.crypto)) {
            return config.currency;
        }
        return config || {};
    }

    function normalizeEntry(raw, code, isCrypto, display) {
        var entry = isObject(raw) ? raw : {};
        var fixed = null;
        if (entry.fixed_rate !== null && entry.fixed_rate !== undefined && entry.fixed_rate !== "") {
            fixed = positiveDecimal(entry.fixed_rate);
        }
        var defaultDecimals = isCrypto ? DEFAULT_CRYPTO_DECIMALS : display.decimal_places;
        var decimals = intValue(entry.decimals, defaultDecimals, 0, 36);
        return {
            code: code,
            enabled: boolValue(entry.enabled, true),
            fixed_rate: fixed,
            fixed_rate_raw: entry.fixed_rate == null ? null : String(entry.fixed_rate),
            rate_url: entry.rate_url == null ? "" : String(entry.rate_url).trim(),
            rate_json_path: entry.rate_json_path == null ? "" : String(entry.rate_json_path).trim(),
            invert_rate: boolValue(entry.invert_rate, false),
            invert_rate_explicit: entry.invert_rate !== undefined && entry.invert_rate !== null,
            decimals: decimals,
            isCrypto: isCrypto
        };
    }

    function mapValue(map, code) {
        if (!isObject(map)) return "";
        if (map[code] != null) return String(map[code]);
        if (map[code.toLowerCase()] != null) return String(map[code.toLowerCase()]);
        if (map[code.toUpperCase()] != null) return String(map[code.toUpperCase()]);
        return "";
    }

    function normalizeProviders(raw) {
        var providers = [];
        if (!isObject(raw)) return providers;
        Object.keys(raw).forEach(function (name) {
            var item = isObject(raw[name]) ? raw[name] : {};
            if (!boolValue(item.enabled, true)) return;
            var url = item.url_template || item.url || "";
            if (!url) return;
            providers.push({
                name: name,
                url_template: String(url).trim(),
                rate_json_path: item.rate_json_path == null ? "" : String(item.rate_json_path).trim(),
                invert_rate: boolValue(item.invert_rate, false),
                ids: isObject(item.ids) ? item.ids :
                    (isObject(item.coin_ids) ? item.coin_ids :
                        (isObject(item.currency_ids) ? item.currency_ids : {})),
                pair_map: isObject(item.pair_map) ? item.pair_map : {},
                result_map: isObject(item.result_map) ? item.result_map : {}
            });
        });
        return providers;
    }

    function applyProvider(entry, provider, shop) {
        var id = mapValue(provider.ids, entry.code);
        if (!id && isObject(provider.ids) && Object.keys(provider.ids).length) return null;
        var mappedPair = mapValue(provider.pair_map, entry.code);
        if (!mappedPair && isObject(provider.pair_map) && Object.keys(provider.pair_map).length) return null;
        var pair = mappedPair || id || entry.code;
        var result = mapValue(provider.result_map, entry.code) || pair;
        var url = provider.url_template
            .replace(/\{currency\}/g, entry.code)
            .replace(/\{shop\}/g, shop)
            .replace(/\{coin_id\}/g, id || entry.code)
            .replace(/\{pair\}/g, pair);
        var path = provider.rate_json_path
            .replace(/\{currency\}/g, entry.code)
            .replace(/\{shop\}/g, shop)
            .replace(/\{coin_id\}/g, id || entry.code)
            .replace(/\{pair\}/g, pair)
            .replace(/\{result\}/g, result);
        return Object.assign({}, entry, {
            rate_url: url,
            rate_json_path: path,
            invert_rate: entry.invert_rate_explicit ? entry.invert_rate : provider.invert_rate,
            provider: provider.name
        });
    }

    function normalizeConfig(config) {
        var currency = currencyObject(config);
        var displayRaw = isObject(currency.display) ? currency.display : {};
        var display = {
            show_amounts: boolValue(displayRaw.show_amounts, true),
            decimal_places: intValue(displayRaw.decimal_places, DEFAULT_DECIMALS, 0, 36)
        };
        var fallbackRaw = isObject(currency.fallback) ? currency.fallback : {};
        var fallback = {
            use_fixed_rate: boolValue(fallbackRaw.use_fixed_rate, true),
            fail_if_no_rate: boolValue(fallbackRaw.fail_if_no_rate, false)
        };
        var supported = {};
        var crypto = {};

        if (isObject(currency.supported)) {
            Object.keys(currency.supported).forEach(function (key) {
                var code = upper(key);
                supported[code] = normalizeEntry(currency.supported[key], code, false, display);
            });
        }
        if (isObject(currency.crypto)) {
            Object.keys(currency.crypto).forEach(function (key) {
                if (lower(key) === "providers") return;
                var code = upper(key);
                crypto[code] = normalizeEntry(currency.crypto[key], code, true, display);
            });
        }

        return {
            shop: upper(currency.shop || "USD") || "USD",
            rate_mode: lower(currency.rate_mode || "automatic") || "automatic",
            auto_fetch: boolValue(currency.auto_fetch, true),
            fetch_on_site_update: boolValue(currency.fetch_on_site_update, false),
            cache_rates: boolValue(currency.cache_rates, true),
            cache_ttl: positiveSeconds(currency.cache_ttl, DEFAULT_CACHE_TTL),
            crypto_cache_ttl: positiveSeconds(currency.crypto_cache_ttl, DEFAULT_CRYPTO_CACHE_TTL),
            supported: supported,
            crypto: crypto,
            providers: normalizeProviders(currency.providers),
            cryptoProviders: normalizeProviders(isObject(currency.crypto) ? currency.crypto.providers : null),
            fallback: fallback,
            display: display,
            prefetched_rates: isObject(currency.prefetched_rates) ? currency.prefetched_rates : {}
        };
    }

    function validateProviders(providers, path, errors) {
        if (providers == null) return;
        if (!isObject(providers)) {
            errors.push(path + " must be a map of providers");
            return;
        }
        Object.keys(providers).forEach(function (name) {
            var provider = isObject(providers[name]) ? providers[name] : {};
            var providerPath = path + "." + name;
            var url = provider.url_template || provider.url;
            if (url !== undefined && String(url).trim() !== "" &&
                !/^https?:\/\//i.test(String(url).trim())) {
                errors.push(providerPath + ".url_template must be an http(s) URL");
            }
            if (url && String(provider.rate_json_path || "").trim() === "") {
                errors.push(providerPath + ".rate_json_path is required");
            }
        });
    }

    function validateConfig(config) {
        var errors = [];
        var warnings = [];
        var currency = currencyObject(config);
        var shop = upper(currency.shop || "USD");
        var mode = lower(currency.rate_mode || "automatic");
        if (!shop) errors.push("currency.shop must be a non-empty currency code");
        if (["fixed", "fetch", "automatic"].indexOf(mode) === -1) {
            errors.push("currency.rate_mode must be fixed, fetch or automatic");
        }
        if (currency.cache_ttl !== undefined && !positiveSeconds(currency.cache_ttl, 0)) {
            errors.push("currency.cache_ttl must be a positive number of seconds");
        }
        if (currency.crypto_cache_ttl !== undefined && !positiveSeconds(currency.crypto_cache_ttl, 0)) {
            errors.push("currency.crypto_cache_ttl must be a positive number of seconds");
        }
        ["supported", "crypto"].forEach(function (section) {
            var map = currency[section];
            if (!isObject(map)) {
                if (map !== undefined) errors.push("currency." + section + " must be a map of currencies");
                return;
            }
            Object.keys(map).forEach(function (key) {
                if (section === "crypto" && lower(key) === "providers") return;
                var raw = isObject(map[key]) ? map[key] : {};
                var path = "currency." + section + "." + upper(key);
                if (!upper(key)) errors.push(path + " must have a currency code");
                if (raw.fixed_rate !== undefined && raw.fixed_rate !== null && raw.fixed_rate !== "" &&
                    !positiveDecimal(raw.fixed_rate)) {
                    errors.push(path + ".fixed_rate must be a positive number");
                }
                if (raw.rate_url !== undefined && String(raw.rate_url).trim() !== "" &&
                    !/^https?:\/\//i.test(String(raw.rate_url).trim())) {
                    errors.push(path + ".rate_url must be an http(s) URL");
                }
                if (raw.rate_url !== undefined && String(raw.rate_url).trim() !== "" &&
                    String(raw.rate_json_path || "").trim() === "") {
                    warnings.push(path + ".rate_json_path is empty; the whole JSON response will be used");
                }
                if (raw.decimals !== undefined &&
                    !intValue(raw.decimals, null, 0, 36)) {
                    errors.push(path + ".decimals must be an integer between 0 and 36");
                }
            });
        });
        validateProviders(currency.providers, "currency.providers", errors);
        if (isObject(currency.crypto)) {
            validateProviders(currency.crypto.providers, "currency.crypto.providers", errors);
        }
        if (!errors.length && !supportedHasRate(currency, shop)) {
            warnings.push("currency.shop " + shop + " has no fixed_rate or rate_url; it still resolves 1:1 with itself");
        }
        return { valid: errors.length === 0, errors: errors, warnings: warnings };
    }

    function supportedHasRate(currency, shop) {
        var maps = [currency.supported, currency.crypto];
        for (var i = 0; i < maps.length; i += 1) {
            if (!isObject(maps[i])) continue;
            var entry = maps[i][shop] || maps[i][shop.toLowerCase()];
            if (isObject(entry) && (entry.fixed_rate != null || entry.rate_url != null)) return true;
        }
        return false;
    }

    /* -- cache -------------------------------------------------------------- */
    function memoryCache(seed) {
        var data = Object.assign({}, seed || {});
        return {
            getItem: function (key) {
                return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
            },
            setItem: function (key, value) { data[key] = String(value); },
            removeItem: function (key) { delete data[key]; },
            dump: function () { return data; }
        };
    }

    function defaultCache() {
        try {
            if (typeof localStorage !== "undefined" && localStorage) {
                var probe = "__exchange_rate_probe__";
                localStorage.setItem(probe, "1");
                localStorage.removeItem(probe);
                return localStorage;
            }
        } catch (error) { /* private windows refuse storage */ }
        return memoryCache();
    }

    function cacheKey(shop, target) {
        return CACHE_PREFIX + shop + ":" + target;
    }

    function ttlMilliseconds(entry, config) {
        return (entry.isCrypto ? config.crypto_cache_ttl : config.cache_ttl) * 1000;
    }

    function signature(entry) {
        return [entry.code, entry.rate_url, entry.rate_json_path, entry.invert_rate ? "1" : "0",
            entry.fixed_rate_raw == null ? "" : entry.fixed_rate_raw].join("|");
    }

    function timestampOf(value) {
        if (typeof value === "number" && isFinite(value)) return value;
        if (typeof value === "string" && value.trim()) {
            var numeric = Number(value);
            if (isFinite(numeric)) return numeric;
            var parsed = Date.parse(value);
            if (isFinite(parsed)) return parsed;
        }
        return null;
    }

    function readCache(cache, target, entry, config, now) {
        if (!cache || !config.cache_rates) return null;
        var raw;
        try { raw = cache.getItem(cacheKey(config.shop, target)); }
        catch (error) { return null; }
        if (!raw) return null;
        var data;
        try { data = typeof raw === "string" ? JSON.parse(raw) : raw; }
        catch (error) { return null; }
        if (!isObject(data)) return null;
        if (upper(data.currency) !== target || upper(data.shop) !== config.shop) return null;
        if (data.isCrypto !== undefined && data.isCrypto !== entry.isCrypto) return null;

        var rate = positiveDecimal(data.rate);
        if (!rate) return null;
        var fetchedAt = timestampOf(data.fetchedAt);
        var expiresAt = timestampOf(data.expiresAt);
        if (fetchedAt == null) return null;
        if (expiresAt == null) expiresAt = fetchedAt + ttlMilliseconds(entry, config);
        if (expiresAt <= now) return null;
        if (data.configSignature && data.configSignature !== signature(entry)) return null;
        if (data.rate_url && data.rate_url !== entry.rate_url) return null;
        if (data.invert_rate !== undefined && !!data.invert_rate !== entry.invert_rate) return null;

        return {
            rate: canonicalDecimal(rate),
            fetchedAt: fetchedAt,
            expiresAt: expiresAt,
            source: data.source || "cache",
            cached: true
        };
    }

    function writeCache(cache, target, entry, config, result) {
        if (!cache || !config.cache_rates) return;
        var data = {
            currency: target,
            shop: config.shop,
            rate: result.rate,
            fetchedAt: result.fetchedAt,
            expiresAt: result.expiresAt,
            source: result.source,
            isCrypto: entry.isCrypto,
            rate_url: entry.rate_url,
            invert_rate: entry.invert_rate,
            configSignature: signature(entry)
        };
        try { cache.setItem(cacheKey(config.shop, target), JSON.stringify(data)); }
        catch (error) { /* a full or blocked cache is not fatal */ }
    }

    function readPrefetched(prefetched, target, entry, config, now) {
        if (!config.cache_rates || !isObject(prefetched)) return null;
        var raw = prefetched[target] || prefetched[target.toLowerCase()];
        if (!isObject(raw)) return null;
        if (raw.currency && upper(raw.currency) !== target) return null;
        var fetchedAt = timestampOf(raw.fetched_at != null ? raw.fetched_at : raw.fetchedAt);
        if (fetchedAt == null) return null;
        var expiresAt = timestampOf(raw.expires_at != null ? raw.expires_at : raw.expiresAt);
        if (expiresAt == null) expiresAt = fetchedAt + ttlMilliseconds(entry, config);
        if (expiresAt <= now) return null;
        if (raw.rate_url && raw.rate_url !== entry.rate_url) return null;

        var normalized;
        if (raw.api_rate != null) {
            var apiRate = positiveDecimal(raw.api_rate);
            if (!apiRate) return null;
            normalized = entry.invert_rate
                ? divideDecimal({ sign: 1, digits: BigInt(1), scale: 0 }, apiRate, MAX_INVERT_SCALE)
                : apiRate;
        } else if (raw.rate != null && raw.normalized === true) {
            normalized = positiveDecimal(raw.rate);
            if (!normalized) return null;
        } else if (raw.rate != null) {
            var rawRate = positiveDecimal(raw.rate);
            if (!rawRate) return null;
            normalized = entry.invert_rate
                ? divideDecimal({ sign: 1, digits: BigInt(1), scale: 0 }, rawRate, MAX_INVERT_SCALE)
                : rawRate;
        } else {
            return null;
        }
        if (!normalized) return null;
        return {
            rate: canonicalDecimal(normalized),
            fetchedAt: fetchedAt,
            expiresAt: expiresAt,
            source: "prefetch",
            cached: true
        };
    }

    /* -- API fetching ------------------------------------------------------- */
    function responseOk(response) {
        if (!response) return false;
        if (response.ok === false) return false;
        if (typeof response.status === "number" && response.status >= 400) return false;
        return true;
    }

    async function responseJson(response) {
        if (!response) throw ExchangeRateError("FETCH_FAILED", "No response from the exchange-rate endpoint");
        if (!responseOk(response)) {
            throw ExchangeRateError("HTTP_ERROR", "Exchange-rate endpoint returned HTTP " +
                (response.status == null ? "error" : response.status));
        }
        var data;
        try {
            if (typeof response.text === "function") {
                var text = await response.text();
                if (!text || !text.trim()) throw new Error("empty response body");
                data = JSON.parse(text);
            } else if (typeof response.json === "function") {
                data = await response.json();
            } else if (typeof response === "object") {
                data = response;
            } else {
                throw new Error("unreadable response");
            }
        } catch (error) {
            throw ExchangeRateError("MALFORMED_JSON", "Exchange-rate endpoint returned malformed JSON", error);
        }
        return data;
    }

    async function fetchApiRate(entry, config, fetchImpl) {
        if (!fetchImpl) throw ExchangeRateError("FETCH_UNAVAILABLE", "No fetch implementation is available");
        if (!entry.rate_url) throw ExchangeRateError("NO_RATE_URL", entry.code + " has no rate_url");
        var response;
        try {
            response = await fetchImpl(entry.rate_url, {
                headers: { Accept: "application/json" },
                cache: config.cache_rates ? "default" : "no-store"
            });
        } catch (error) {
            throw ExchangeRateError("FETCH_FAILED", "Could not reach the exchange-rate endpoint for " + entry.code, error);
        }
        var data = await responseJson(response);
        var raw = extractJsonPath(data, entry.rate_json_path);
        var apiRate = positiveDecimal(raw);
        if (!apiRate) {
            throw ExchangeRateError("INVALID_RATE", "Exchange-rate response for " + entry.code +
                " did not contain a positive numeric value at " + (entry.rate_json_path || "<root>"));
        }
        var normalized = entry.invert_rate
            ? divideDecimal({ sign: 1, digits: BigInt(1), scale: 0 }, apiRate, MAX_INVERT_SCALE)
            : apiRate;
        if (!normalized) {
            throw ExchangeRateError("INVALID_RATE", "The inverted exchange rate for " + entry.code + " is invalid");
        }
        return {
            rate: canonicalDecimal(normalized),
            apiRate: canonicalDecimal(apiRate),
            inverted: entry.invert_rate
        };
    }

    /* -- resolver ----------------------------------------------------------- */
    function createResolver(config, options) {
        options = options || {};
        var normalized = normalizeConfig(config);
        var fetchImpl = options.fetch || (typeof fetch !== "undefined" ? fetch.bind(root) : null);
        var now = options.now || function () { return Date.now(); };
        var cache = options.cache === false ? null : (options.cache || defaultCache());
        var prefetched = options.prefetched || normalized.prefetched_rates || {};
        var defaultContext = options.context || "runtime";

        function entryFor(target) {
            var code = upper(target);
            if (!code) return null;
            var entry = normalized.crypto[code] || normalized.supported[code] || null;
            if (entry) {
                if (!entry.rate_url) {
                    var providers = (entry.isCrypto ? normalized.cryptoProviders : []).concat(normalized.providers);
                    for (var i = 0; i < providers.length; i += 1) {
                        var withProvider = applyProvider(entry, providers[i], normalized.shop);
                        if (withProvider) return withProvider;
                    }
                }
                return entry;
            }
            if (code === normalized.shop) {
                return {
                    code: code,
                    enabled: true,
                    fixed_rate: { sign: 1, digits: BigInt(1), scale: 0 },
                    fixed_rate_raw: "1",
                    rate_url: "",
                    rate_json_path: "",
                    invert_rate: false,
                    decimals: normalized.display.decimal_places,
                    isCrypto: false,
                    identity: true
                };
            }
            return null;
        }

        function resultFor(target, entry, rate, source, extra) {
            extra = extra || {};
            return {
                currency: target,
                shop: normalized.shop,
                rate: canonicalDecimal(rate),
                source: source,
                isCrypto: entry.isCrypto,
                decimals: entry.decimals,
                inverted: entry.invert_rate,
                rate_url: entry.rate_url || null,
                fetchedAt: extra.fetchedAt == null ? null : extra.fetchedAt,
                expiresAt: extra.expiresAt == null ? null : extra.expiresAt,
                cached: extra.cached === true,
                fallback: extra.fallback === true,
                identity: entry.identity === true
            };
        }

        function fixedResult(target, entry, source, extra) {
            if (!entry.fixed_rate) {
                throw ExchangeRateError("MISSING_RATE", "No fixed_rate is configured for " + target);
            }
            return resultFor(target, entry, entry.fixed_rate, source, extra);
        }

        async function resolveRate(target, callOptions) {
            callOptions = callOptions || {};
            var code = upper(target);
            var entry = entryFor(code);
            if (!entry) {
                throw ExchangeRateError("CURRENCY_NOT_CONFIGURED", "Currency " + code + " is not configured");
            }
            if (!entry.enabled) {
                throw ExchangeRateError("CURRENCY_DISABLED", "Currency " + code + " is disabled");
            }
            if (entry.identity) {
                return resultFor(code, entry, entry.fixed_rate, "identity");
            }

            var mode = normalized.rate_mode;
            if (mode === "fixed") return fixedResult(code, entry, "fixed");

            var currentTime = now();
            var cached = readCache(cache, code, entry, normalized, currentTime);
            if (cached) {
                return resultFor(code, entry, parseDecimal(cached.rate), cached.source, {
                    fetchedAt: cached.fetchedAt,
                    expiresAt: cached.expiresAt,
                    cached: true
                });
            }

            var prefetchedRate = readPrefetched(prefetched, code, entry, normalized, currentTime);
            if (prefetchedRate) {
                writeCache(cache, code, entry, normalized, prefetchedRate);
                return resultFor(code, entry, parseDecimal(prefetchedRate.rate), prefetchedRate.source, {
                    fetchedAt: prefetchedRate.fetchedAt,
                    expiresAt: prefetchedRate.expiresAt,
                    cached: true
                });
            }

            var context = callOptions.context || defaultContext;
            var mayFetch = !!fetchImpl && !!entry.rate_url && (
                (context === "build" && normalized.fetch_on_site_update) ||
                (context !== "build" && normalized.auto_fetch)
            );

            if (mayFetch) {
                try {
                    var fetched = await fetchApiRate(entry, normalized, fetchImpl);
                    var fetchedAt = now();
                    var expiresAt = fetchedAt + ttlMilliseconds(entry, normalized);
                    var fresh = {
                        rate: fetched.rate,
                        fetchedAt: fetchedAt,
                        expiresAt: expiresAt,
                        source: "api"
                    };
                    writeCache(cache, code, entry, normalized, fresh);
                    return resultFor(code, entry, parseDecimal(fresh.rate), "api", {
                        fetchedAt: fetchedAt,
                        expiresAt: expiresAt
                    });
                } catch (error) {
                    if (mode === "automatic" && normalized.fallback.use_fixed_rate &&
                        !normalized.fallback.fail_if_no_rate) {
                        return fixedResult(code, entry, "fallback", { fallback: true });
                    }
                    throw error;
                }
            }

            if (mode === "automatic" && normalized.fallback.use_fixed_rate &&
                !normalized.fallback.fail_if_no_rate) {
                return fixedResult(code, entry, "fixed", { fallback: true });
            }
            if (mode === "fetch") {
                throw ExchangeRateError("NO_RATE", "No fetched or cached rate is available for " + code);
            }
            throw ExchangeRateError("NO_RATE", "No exchange rate is available for " + code);
        }

        function applyConversion(amount, rateInfo, conversionOptions) {
            conversionOptions = conversionOptions || {};
            var amountDecimal = parseDecimal(amount);
            if (!amountDecimal || amountDecimal.sign < 0) {
                throw ExchangeRateError("INVALID_AMOUNT", "Amount must be zero or a positive number");
            }
            var rateDecimal = positiveDecimal(rateInfo.rate);
            if (!rateDecimal) {
                throw ExchangeRateError("INVALID_RATE", "Resolved rate for " + rateInfo.currency + " is invalid");
            }
            var product = multiplyDecimal(amountDecimal, rateDecimal);
            var rounding = conversionOptions.rounding || (rateInfo.isCrypto ? "ceil" : "half-up");
            var decimals = rateInfo.decimals;
            var rounded = roundDecimal(product, decimals, rounding);
            if (!rounded || rounded.sign < 0) {
                throw ExchangeRateError("INVALID_AMOUNT", "Converted amount is invalid");
            }
            var amountText = canonicalDecimal(rounded, null);
            var formatted = canonicalDecimal(rounded, decimals);
            return Object.assign({}, rateInfo, {
                amount: amountText,
                formattedAmount: formatted,
                rounding: rounding
            });
        }

        async function convert(target, amount, conversionOptions) {
            var rateInfo = await resolveRate(target, conversionOptions);
            return applyConversion(amount, rateInfo, conversionOptions);
        }

        function clearCache() {
            if (!cache) return;
            Object.keys(normalized.supported).forEach(function (code) {
                try { cache.removeItem(cacheKey(normalized.shop, code)); } catch (error) { /* ignore */ }
            });
            Object.keys(normalized.crypto).forEach(function (code) {
                try { cache.removeItem(cacheKey(normalized.shop, code)); } catch (error) { /* ignore */ }
            });
        }

        return {
            config: normalized,
            resolveRate: resolveRate,
            convert: convert,
            convertAmount: applyConversion,
            clearCache: clearCache,
            cache: cache
        };
    }

    return {
        VERSION: VERSION,
        createResolver: createResolver,
        normalizeConfig: normalizeConfig,
        validateConfig: validateConfig,
        extractJsonPath: extractJsonPath,
        validateRate: function (value) { return positiveDecimal(value) !== null; },
        parseDecimal: parseDecimal,
        canonicalDecimal: canonicalDecimal,
        formatAmount: formatAmount,
        addAmounts: addAmounts,
        multiplyAmount: multiplyAmount,
        convertAmount: function (amount, rate, decimals, options) {
            options = options || {};
            var rateInfo = {
                currency: options.currency || "",
                shop: options.shop || "",
                rate: String(rate),
                isCrypto: options.isCrypto === true,
                decimals: decimals == null ? DEFAULT_DECIMALS : decimals,
                inverted: false
            };
            var rateDecimal = positiveDecimal(rateInfo.rate);
            if (!rateDecimal) throw ExchangeRateError("INVALID_RATE", "Rate must be a positive number");
            var amountDecimal = parseDecimal(amount);
            if (!amountDecimal || amountDecimal.sign < 0) {
                throw ExchangeRateError("INVALID_AMOUNT", "Amount must be zero or a positive number");
            }
            var product = multiplyDecimal(amountDecimal, rateDecimal);
            var rounding = options.rounding || (rateInfo.isCrypto ? "ceil" : "half-up");
            var rounded = roundDecimal(product, rateInfo.decimals, rounding);
            return {
                amount: canonicalDecimal(rounded, null),
                formattedAmount: canonicalDecimal(rounded, rateInfo.decimals),
                decimals: rateInfo.decimals,
                rounding: rounding,
                rate: canonicalDecimal(rateDecimal)
            };
        },
        createMemoryCache: memoryCache,
        cacheKey: cacheKey,
        ExchangeRateError: ExchangeRateError
    };
}));
