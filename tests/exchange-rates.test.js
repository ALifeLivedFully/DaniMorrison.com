const test = require("node:test");
const assert = require("node:assert/strict");
const ER = require("../static/js/exchange-rates.js");

const NOW = 1700000000000;

function makeConfig(overrides = {}) {
  return Object.assign({
    shop: "USD",
    rate_mode: "automatic",
    auto_fetch: true,
    fetch_on_site_update: false,
    cache_rates: true,
    cache_ttl: 3600,
    crypto_cache_ttl: 300,
    supported: {
      USD: { enabled: true, fixed_rate: 1.0 },
      EUR: { enabled: true, fixed_rate: 0.8760402979 }
    },
    crypto: {
      BTC: { enabled: true, fixed_rate: 0.00001, decimals: 8 }
    },
    fallback: { use_fixed_rate: true, fail_if_no_rate: false },
    display: { show_amounts: true, decimal_places: 2 }
  }, overrides);
}

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status == null ? 200 : options.status,
    text: async () => typeof body === "string" ? body : JSON.stringify(body)
  };
}

function failingFetch() {
  return async () => { throw new Error("offline"); };
}

function makeResolver(config, options = {}) {
  return ER.createResolver(config, Object.assign({
    now: () => NOW,
    cache: ER.createMemoryCache(),
    fetch: failingFetch()
  }, options));
}

test("USD to EUR uses the configured rate (fixed mode)", async () => {
  const result = await makeResolver(makeConfig({ rate_mode: "fixed" }))
    .convert("EUR", "10", { context: "checkout" });
  assert.equal(result.currency, "EUR");
  assert.equal(result.rate, "0.8760402979");
  assert.equal(result.amount, "8.76");
  assert.equal(result.formattedAmount, "8.76");
  assert.equal(result.source, "fixed");
});

test("USD to BTC converts the whole order total with crypto precision", async () => {
  const result = await makeResolver(makeConfig({ rate_mode: "fixed" }))
    .convert("BTC", "10", { context: "checkout" });
  assert.equal(result.currency, "BTC");
  assert.equal(result.isCrypto, true);
  assert.equal(result.rate, "0.00001");
  assert.equal(result.amount, "0.0001");
  assert.equal(result.formattedAmount, "0.00010000");
  assert.equal(result.decimals, 8);
  assert.equal(result.rounding, "ceil");
});

test("non-USD shop currency converts from the shop currency", async () => {
  const config = makeConfig({
    shop: "EUR",
    rate_mode: "fixed",
    supported: {
      EUR: { enabled: true, fixed_rate: 1.0 },
      USD: { enabled: true, fixed_rate: 1.14155 }
    }
  });
  const result = await makeResolver(config).convert("USD", "10");
  assert.equal(result.shop, "EUR");
  assert.equal(result.rate, "1.14155");
  assert.equal(result.formattedAmount, "11.42");
});

test("fixed mode never calls the API", async () => {
  let calls = 0;
  const config = makeConfig({
    rate_mode: "fixed",
    supported: {
      USD: { enabled: true, fixed_rate: 1.0 },
      EUR: { enabled: true, fixed_rate: 0.876, rate_url: "https://example.test/eur", rate_json_path: "rate" }
    }
  });
  const resolver = makeResolver(config, {
    fetch: async () => { calls += 1; return jsonResponse({ rate: 0.5 }); }
  });
  await resolver.resolveRate("EUR");
  assert.equal(calls, 0);
});

test("fetch mode retrieves, validates and caches an API rate", async () => {
  let calls = 0;
  const config = makeConfig({
    rate_mode: "fetch",
    supported: {
      USD: { enabled: true, fixed_rate: 1.0 },
      EUR: { rate_url: "https://example.test/eur", rate_json_path: "rate", invert_rate: false }
    }
  });
  const resolver = makeResolver(config, {
    fetch: async () => { calls += 1; return jsonResponse({ rate: 0.876 }); }
  });
  const first = await resolver.resolveRate("EUR");
  assert.equal(first.rate, "0.876");
  assert.equal(first.source, "api");
  const second = await resolver.resolveRate("EUR");
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test("automatic mode falls back to the fixed rate when fetching fails", async () => {
  const config = makeConfig({
    supported: {
      USD: { enabled: true, fixed_rate: 1.0 },
      EUR: { enabled: true, fixed_rate: 0.876, rate_url: "https://example.test/eur", rate_json_path: "rate" }
    }
  });
  const result = await makeResolver(config).resolveRate("EUR");
  assert.equal(result.rate, "0.876");
  assert.equal(result.source, "fallback");
  assert.equal(result.fallback, true);
});

test("a malformed JSON response is rejected and automatic mode falls back", async () => {
  const config = makeConfig({
    supported: {
      USD: { enabled: true, fixed_rate: 1.0 },
      EUR: { enabled: true, fixed_rate: 0.876, rate_url: "https://example.test/eur", rate_json_path: "rate" }
    }
  });
  const resolver = makeResolver(config, {
    fetch: async () => jsonResponse("this is not json")
  });
  const result = await resolver.resolveRate("EUR");
  assert.equal(result.source, "fallback");
});

test("HTTP errors are surfaced in fetch mode", async () => {
  const config = makeConfig({
    rate_mode: "fetch",
    supported: {
      USD: { enabled: true, fixed_rate: 1.0 },
      EUR: { rate_url: "https://example.test/eur", rate_json_path: "rate" }
    }
  });
  const resolver = makeResolver(config, {
    fetch: async () => jsonResponse({ error: "nope" }, { ok: false, status: 503 })
  });
  await assert.rejects(resolver.resolveRate("EUR"), (error) => {
    assert.equal(error.code, "HTTP_ERROR");
    return true;
  });
});

test("JSON path extraction handles nested objects and arrays", () => {
  const data = { quotes: { USD: { price: 100000 } }, data: [{ rate: 0.5 }] };
  assert.equal(ER.extractJsonPath(data, "quotes.USD.price"), 100000);
  assert.equal(ER.extractJsonPath(data, "data.0.rate"), 0.5);
  assert.equal(ER.extractJsonPath(data, "quotes.EUR.price"), undefined);
  assert.equal(ER.extractJsonPath(data, ""), data);
});

test("inverted and non-inverted API rates both normalize to target per shop", async () => {
  let calls = 0;
  const config = makeConfig({
    rate_mode: "fetch",
    supported: {
      USD: { enabled: true, fixed_rate: 1.0 },
      EUR: { rate_url: "https://example.test/eur", rate_json_path: "rate", invert_rate: false }
    },
    crypto: {
      BTC: { enabled: true, decimals: 8, rate_url: "https://example.test/btc", rate_json_path: "price", invert_rate: true }
    }
  });
  const resolver = makeResolver(config, {
    cache: false,
    fetch: async (url) => {
      calls += 1;
      return url.includes("btc") ? jsonResponse({ price: 100000 }) : jsonResponse({ rate: 0.876 });
    }
  });
  const eur = await resolver.resolveRate("EUR");
  const btc = await resolver.resolveRate("BTC");
  assert.equal(eur.rate, "0.876");
  assert.equal(btc.rate, "0.00001");
  assert.equal(calls, 2);
});

test("a valid cached rate is used without fetching", async () => {
  let calls = 0;
  const cache = ER.createMemoryCache({
    [ER.cacheKey("USD", "EUR")]: JSON.stringify({
      currency: "EUR",
      shop: "USD",
      rate: "0.876",
      fetchedAt: NOW - 1000,
      expiresAt: NOW + 1000,
      isCrypto: false
    })
  });
  const config = makeConfig({
    rate_mode: "fetch",
    supported: {
      USD: { enabled: true, fixed_rate: 1.0 },
      EUR: { rate_url: "https://example.test/eur", rate_json_path: "rate" }
    }
  });
  const resolver = makeResolver(config, {
    cache: cache,
    fetch: async () => { calls += 1; return jsonResponse({ rate: 0.5 }); }
  });
  const result = await resolver.resolveRate("EUR");
  assert.equal(result.rate, "0.876");
  assert.equal(result.source, "cache");
  assert.equal(calls, 0);
});

test("expired fiat cache is not used; automatic mode falls back to fixed", async () => {
  const cache = ER.createMemoryCache({
    [ER.cacheKey("USD", "EUR")]: JSON.stringify({
      currency: "EUR",
      shop: "USD",
      rate: "0.876",
      fetchedAt: NOW - 7200,
      expiresAt: NOW - 1000,
      isCrypto: false
    })
  });
  const config = makeConfig({
    supported: {
      USD: { enabled: true, fixed_rate: 1.0 },
      EUR: { enabled: true, fixed_rate: 0.9, rate_url: "https://example.test/eur", rate_json_path: "rate" }
    }
  });
  const result = await makeResolver(config, { cache }).resolveRate("EUR");
  assert.equal(result.rate, "0.9");
  assert.equal(result.source, "fallback");
});

test("expired cryptocurrency cache is rejected at checkout", async () => {
  const cache = ER.createMemoryCache({
    [ER.cacheKey("USD", "BTC")]: JSON.stringify({
      currency: "BTC",
      shop: "USD",
      rate: "0.00001",
      fetchedAt: NOW - 1000,
      expiresAt: NOW - 1,
      isCrypto: true
    })
  });
  const config = makeConfig({
    rate_mode: "fetch",
    crypto: {
      BTC: { enabled: true, decimals: 8, rate_url: "https://example.test/btc", rate_json_path: "price" }
    }
  });
  await assert.rejects(
    makeResolver(config, { cache, fetch: failingFetch() }).convert("BTC", "10", { context: "checkout" }),
    (error) => {
      assert.equal(error.code, "FETCH_FAILED");
      return true;
    }
  );
});

test("offline operation uses fixed rates when auto_fetch is off", async () => {
  let calls = 0;
  const config = makeConfig({
    auto_fetch: false,
    supported: {
      USD: { enabled: true, fixed_rate: 1.0 },
      EUR: { enabled: true, fixed_rate: 0.876, rate_url: "https://example.test/eur", rate_json_path: "rate" }
    }
  });
  const result = await makeResolver(config, {
    fetch: async () => { calls += 1; return jsonResponse({ rate: 0.5 }); }
  }).resolveRate("EUR");
  assert.equal(result.rate, "0.876");
  assert.equal(result.source, "fixed");
  assert.equal(calls, 0);
});

test("missing, disabled, zero and negative rates are rejected", async () => {
  const config = makeConfig({
    supported: {
      USD: { enabled: true, fixed_rate: 1.0 },
      EUR: { enabled: false, fixed_rate: 0.876 },
      ZWL: { enabled: true, fixed_rate: 0 },
      XXX: { enabled: true, fixed_rate: -1 }
    }
  });
  const resolver = makeResolver(config, { cache: false });
  await assert.rejects(resolver.resolveRate("GBP"), /not configured/);
  await assert.rejects(resolver.resolveRate("EUR"), (error) => error.code === "CURRENCY_DISABLED");
  await assert.rejects(resolver.resolveRate("ZWL"), (error) => error.code === "MISSING_RATE");
  await assert.rejects(resolver.resolveRate("XXX"), (error) => error.code === "MISSING_RATE");
});

test("an API value of null, zero or negative is not cached and does not become 1:1", async () => {
  for (const value of [null, 0, -1, "not-a-number"]) {
    const config = makeConfig({
      rate_mode: "fetch",
      supported: {
        USD: { enabled: true, fixed_rate: 1.0 },
        EUR: { rate_url: "https://example.test/eur", rate_json_path: "rate" }
      }
    });
    const resolver = makeResolver(config, {
      fetch: async () => jsonResponse({ rate: value })
    });
    await assert.rejects(resolver.resolveRate("EUR"), (error) => {
      assert.equal(error.code, "INVALID_RATE");
      return true;
    });
  }
});

test("cryptocurrency amounts round up rather than underpaying", async () => {
  const config = makeConfig({
    rate_mode: "fixed",
    crypto: {
      BTC: { enabled: true, fixed_rate: 0.00001, decimals: 8 }
    }
  });
  const result = await makeResolver(config).convert("BTC", "1.23456789");
  assert.equal(result.amount, "0.00001235");
  assert.equal(result.formattedAmount, "0.00001235");
});

test("build-time fetching is only allowed with fetch_on_site_update", async () => {
  let calls = 0;
  const config = makeConfig({
    fetch_on_site_update: false,
    supported: {
      USD: { enabled: true, fixed_rate: 1.0 },
      EUR: { enabled: true, fixed_rate: 0.876, rate_url: "https://example.test/eur", rate_json_path: "rate" }
    }
  });
  const resolver = makeResolver(config, {
    fetch: async () => { calls += 1; return jsonResponse({ rate: 0.5 }); }
  });
  const result = await resolver.resolveRate("EUR", { context: "build" });
  assert.equal(result.source, "fixed");
  assert.equal(result.fallback, true);
  assert.equal(calls, 0);
});

test("a prefetched build rate is validated and cached", async () => {
  const config = makeConfig({
    rate_mode: "automatic",
    supported: {
      USD: { enabled: true, fixed_rate: 1.0 },
      EUR: { enabled: true, fixed_rate: 0.876, rate_url: "https://example.test/eur", rate_json_path: "rate" }
    }
  });
  const resolver = makeResolver(config, {
    prefetched: {
      EUR: { api_rate: 0.876, fetched_at: NOW - 1000, rate_url: "https://example.test/eur" }
    }
  });
  const first = await resolver.resolveRate("EUR");
  assert.equal(first.rate, "0.876");
  assert.equal(first.source, "prefetch");
  assert.equal(first.cached, true);
  const second = await resolver.resolveRate("EUR");
  assert.equal(second.rate, "0.876");
  assert.equal(second.cached, true);
});

test("configuration validation reports useful errors and warnings", () => {
  const result = ER.validateConfig({
    shop: "USD",
    rate_mode: "sometimes",
    supported: { EUR: { fixed_rate: -1, rate_url: "ftp://bad", decimals: "x" } }
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((message) => message.includes("rate_mode")));
  assert.ok(result.errors.some((message) => message.includes("fixed_rate")));
  assert.ok(result.errors.some((message) => message.includes("rate_url")));
  assert.ok(result.errors.some((message) => message.includes("decimals")));
});

test("decimal helpers avoid floating-point accumulation", () => {
  assert.equal(ER.addAmounts(["0.1", "0.2"]), "0.3");
  assert.equal(ER.multiplyAmount("19.99", 3), "59.97");
  assert.equal(ER.formatAmount("0.0000123456789", 8, { rounding: "ceil" }), "0.00001235");
});

test("createResolver uses the global browser fetch without an injected implementation", () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    const resolver = ER.createResolver(makeConfig({ rate_mode: "fetch" }), {
      now: () => NOW,
      cache: false
    });
    assert.equal(typeof resolver.resolveRate, "function");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a shared fiat provider builds its URL from shop and target currency", async () => {
  let requested = "";
  const config = makeConfig({
    rate_mode: "fetch",
    supported: {
      USD: { enabled: true, fixed_rate: 1.0 },
      EUR: { enabled: true }
    },
    providers: {
      frankfurter: {
        enabled: true,
        url_template: "https://api.frankfurter.app/latest?from={shop}&to={currency}",
        rate_json_path: "rates.{currency}",
        invert_rate: false
      }
    }
  });
  const resolver = makeResolver(config, {
    cache: false,
    fetch: async (url) => {
      requested = url;
      return jsonResponse({ rates: { EUR: 0.876 } });
    }
  });
  const result = await resolver.resolveRate("EUR");
  assert.equal(requested, "https://api.frankfurter.app/latest?from=USD&to=EUR");
  assert.equal(result.rate, "0.876");
});

test("CoinPaprika provider maps coin IDs and inverts the quoted price", async () => {
  let requested = "";
  const config = makeConfig({
    rate_mode: "fetch",
    crypto: {
      BTC: { enabled: true, decimals: 8 },
      providers: {
        coinpaprika: {
          enabled: true,
          url_template: "https://api.coinpaprika.com/v1/tickers/{coin_id}",
          rate_json_path: "quotes.USD.price",
          invert_rate: true,
          coin_ids: { BTC: "btc-bitcoin" }
        }
      }
    }
  });
  const resolver = makeResolver(config, {
    cache: false,
    fetch: async (url) => {
      requested = url;
      return jsonResponse({ quotes: { USD: { price: 100000 } } });
    }
  });
  const result = await resolver.resolveRate("BTC");
  assert.equal(requested, "https://api.coinpaprika.com/v1/tickers/btc-bitcoin");
  assert.equal(result.rate, "0.00001");
});

test("Kraken provider maps the query pair and response key separately", async () => {
  let requested = "";
  const config = makeConfig({
    rate_mode: "fetch",
    crypto: {
      BTC: { enabled: true, decimals: 8 },
      providers: {
        kraken: {
          enabled: true,
          url_template: "https://api.kraken.com/0/public/Ticker?pair={pair}",
          rate_json_path: "result.{result}.c.0",
          invert_rate: true,
          pair_map: { BTC: "XBTUSD" },
          result_map: { BTC: "XXBTZUSD" }
        }
      }
    }
  });
  const resolver = makeResolver(config, {
    cache: false,
    fetch: async (url) => {
      requested = url;
      return jsonResponse({ result: { XXBTZUSD: { c: ["100000", "1"] } } });
    }
  });
  const result = await resolver.resolveRate("BTC");
  assert.equal(requested, "https://api.kraken.com/0/public/Ticker?pair=XBTUSD");
  assert.equal(result.rate, "0.00001");
});

test("a direct currency URL takes priority over shared providers", async () => {
  let requested = "";
  const config = makeConfig({
    rate_mode: "fetch",
    crypto: {
      BTC: {
        enabled: true,
        decimals: 8,
        rate_url: "https://example.test/direct",
        rate_json_path: "price",
        invert_rate: true
      },
      providers: {
        coinpaprika: {
          enabled: true,
          url_template: "https://api.coinpaprika.com/v1/tickers/{coin_id}",
          rate_json_path: "quotes.USD.price",
          invert_rate: true,
          coin_ids: { BTC: "btc-bitcoin" }
        }
      }
    }
  });
  const resolver = makeResolver(config, {
    cache: false,
    fetch: async (url) => {
      requested = url;
      return jsonResponse({ price: 100000 });
    }
  });
  await resolver.resolveRate("BTC");
  assert.equal(requested, "https://example.test/direct");
});
