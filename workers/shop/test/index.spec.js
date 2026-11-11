import { env, createExecutionContext, waitOnExecutionContext, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src";

const ORIGIN = "http://localhost:1313";
const CATALOG_URL = `${ORIGIN}/shop/index.json`;

const config = {
  shop_id: "danimorrison",
  currency: { shop: "USD", code: "USD", symbol: "$", position: "prefix" },
  catalog_url: CATALOG_URL,
  shipping: {
    active: true,
    options: [
      { title: "Shipping NL", label: "The Netherlands", price: 0 },
      { title: "Shipping World", label: "Rest of the world", price: 15 }
    ]
  },
  custom_values: [
    {
      title: "Gift wrapping",
      options: [
        { title: "Not gift wrapped", value: "no", price: 0 },
        { title: "Gift wrapped", value: "yes", price: 2 }
      ]
    },
    {
      title: "Custom engraving",
      options: [
        { title: "No engraving", value: "no", price: 0 },
        { title: "Custom engraved", value: "yes", price: 20 }
      ]
    }
  ]
};

const catalog = {
  version: 1,
  currency: "USD",
  items: [
    {
      sku: "coffee",
      title: "Buy me a coffee",
      price: 3.5,
      available: true,
      variants: [
        { sku: "coffeetall", name: "tall", price: 2.5 },
        { sku: "coffeegrande", name: "grande", price: 3.5 }
      ]
    }
  ]
};

const order = (overrides = {}) => ({
  schema_version: 1,
  shop_id: "danimorrison",
  ordernumber: "1234567890",
  customer: {
    firstname: "Test",
    lastname: "User",
    email: "test@example.com",
    address: "1 Test Way",
    zipcode: "12345",
    city: "Testville",
    country: "USA"
  },
  items: [{ sku: "coffeegrande", quantity: 2 }],
  shipping: { title: "Shipping World" },
  addons: [
    { group: "Gift wrapping", value: "yes" },
    { group: "Custom engraving", value: "no" }
  ],
  message: "",
  currency: "USD",
  _next: "/payment/",
  ...overrides
});

async function seedShop(overrides = {}) {
  await env.orders.prepare(`
    INSERT INTO shops (id, origin, site_config_url, catalog_url, active, config_cache, stripe_secret_key, stripe_webhook_secret)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    overrides.id ?? "danimorrison",
    overrides.origin ?? ORIGIN,
    overrides.site_config_url ?? `${ORIGIN}/payment.json`,
    overrides.catalog_url ?? CATALOG_URL,
    overrides.active ?? 1,
    JSON.stringify(overrides.config ?? config),
    overrides.stripeSecretKey ?? null,
    overrides.stripeWebhookSecret ?? null
  ).run();
}

function mockCatalog(value = catalog) {
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    if (String(input) === CATALOG_URL) {
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  }));
}

function mockSite() {
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    const url = String(input);
    if (url === `${ORIGIN}/payment.json`) {
      return new Response(JSON.stringify(config), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url === CATALOG_URL) {
      return new Response(JSON.stringify(catalog), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  }));
}

const STRIPE_SESSIONS_URL = "https://api.stripe.com/v1/checkout/sessions";

function mockSiteWithStripe({ sessions = [], status = 200, error = "Stripe error" } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const url = String(input);
    if (url === STRIPE_SESSIONS_URL) {
      calls.push({ url, init });
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { message: error } }), {
          status,
          headers: { "Content-Type": "application/json" }
        });
      }
      const session = sessions.length
        ? sessions[Math.min(calls.length - 1, sessions.length - 1)]
        : { id: "cs_test_session", url: "https://checkout.stripe.com/test" };
      return new Response(JSON.stringify(session), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url === `${ORIGIN}/payment.json`) {
      return new Response(JSON.stringify(config), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url === CATALOG_URL) {
      return new Response(JSON.stringify(catalog), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  }));
  return calls;
}

const WEBHOOK_SECRET = "whsec_test_secret";

async function stripeSignature(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${body}`)
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${hex}`;
}

async function signedWebhookRequest(event, overrides = {}) {
  const body = JSON.stringify(event);
  const signature = await stripeSignature(
    overrides.secret ?? WEBHOOK_SECRET,
    body,
    overrides.timestamp ?? Math.floor(Date.now() / 1000)
  );
  return new Request("http://localhost:8787/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(overrides.signed === false ? {} : { "Stripe-Signature": signature })
    },
    body
  });
}

function envWithOrderInsertError(error) {
  const run = async (sql) => {
    if (sql.includes("INSERT INTO orders")) throw error;
    return { meta: { last_row_id: 1 } };
  };
  const shop = {
    id: "danimorrison",
    origin: ORIGIN,
    site_config_url: `${ORIGIN}/payment.json`,
    catalog_url: CATALOG_URL,
    active: 1,
    config_cache: JSON.stringify(config)
  };
  return {
    orders: {
      prepare(sql) {
        const first = async () => String(sql).includes("FROM shops") ? shop : null;
        const bound = {
          first,
          all: async () => ({ results: [] }),
          run: () => run(sql),
          __run: () => run(sql)
        };
        return {
          bind: () => bound,
          first,
          all: async () => ({ results: [] })
        };
      },
      async batch(statements) {
        return Promise.all(statements.map((statement) => statement.__run()));
      }
    }
  };
}

function envWithSchemaError(error) {
  return {
    orders: {
      prepare() {
        return {
          bind() {
            return {
              first: async () => { throw error; },
              all: async () => { throw error; },
              run: async () => { throw error; }
            };
          },
          first: async () => { throw error; },
          all: async () => { throw error; }
        };
      },
      async batch() { throw error; }
    }
  };
}

function postJson(body, origin = ORIGIN, path = "/") {
  const request = new Request(`http://localhost:8787${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {})
    },
    body: JSON.stringify(body)
  });
  const ctx = createExecutionContext();
  return {
    request,
    respond: async () => {
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    }
  };
}

function postForm(body, origin = ORIGIN) {
  const request = new Request("http://localhost:8787/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(origin ? { Origin: origin } : {})
    },
    body
  });
  const ctx = createExecutionContext();
  return {
    request,
    respond: async () => {
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    }
  };
}

function checkoutRequest(body) {
  const request = new Request("http://localhost:8787/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const ctx = createExecutionContext();
  return {
    request,
    respond: async () => {
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    }
  };
}

async function readOrder(ordernumber = "1234567890") {
  const ctx = createExecutionContext();
  const row = await env.orders.prepare(
    "SELECT * FROM orders WHERE ordernumber = ? ORDER BY id DESC LIMIT 1"
  ).bind(ordernumber).first();
  await waitOnExecutionContext(ctx);
  return row;
}

async function countRows(table) {
  const ctx = createExecutionContext();
  const row = await env.orders.prepare(
    `SELECT COUNT(*) AS n FROM ${table}`
  ).first();
  await waitOnExecutionContext(ctx);
  return row.n;
}

beforeEach(async () => {
  const ctx = createExecutionContext();
  await env.orders.prepare("DELETE FROM order_validation_checks").run();
  await env.orders.prepare("DELETE FROM order_addons").run();
  await env.orders.prepare("DELETE FROM order_items").run();
  await env.orders.prepare("DELETE FROM order_status_history").run();
  await env.orders.prepare("DELETE FROM order_submissions").run();
  await env.orders.prepare("DELETE FROM payment_intents").run();
  await env.orders.prepare("DELETE FROM orders").run();
  await env.orders.prepare("DELETE FROM claims").run();
  await env.orders.prepare("DELETE FROM webhook_events").run();
  await env.orders.prepare("DELETE FROM shops").run();
  await waitOnExecutionContext(ctx);
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the order worker", () => {
  it("refuses anything but a post", async () => {
    const response = await SELF.fetch("http://localhost:8787");
    expect(response.status).toBe(405);
  });

  it("accepts a structured JSON order and marks it validated", async () => {
    await seedShop();
    mockCatalog();

    const { respond } = postJson(order());
    const response = await respond();
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.status).toBe("validated");
    expect(body.totals).toEqual({
      subtotal: 7,
      shipping: 15,
      addons: 2,
      total: 24,
      currency: "USD"
    });

    const saved = await readOrder();
    expect(saved.status).toBe("validated");
    expect(saved.subtotal).toBe(7);
    expect(saved.shipping_cost).toBe(15);
    expect(saved.addons_total).toBe(2);
    expect(saved.total).toBe(24);
    expect(saved.fulfillment_status).toBe("unfulfilled");

    const items = await env.orders.prepare(
      "SELECT * FROM order_items WHERE order_id = ? ORDER BY position"
    ).bind(saved.id).all();
    expect(items.results[0]).toMatchObject({
      sku: "coffeegrande",
      title: "Buy me a coffee",
      variant: "grande",
      quantity: 2,
      unit_price: 3.5,
      line_total: 7
    });
  });

  it("stores relational children and the raw submission", async () => {
    await seedShop();
    mockCatalog();
    await postJson(order()).respond();

    const saved = await readOrder();
    const [items, addons, history, submissions] = await Promise.all([
      env.orders.prepare(
        "SELECT * FROM order_items WHERE order_id = ? ORDER BY position"
      ).bind(saved.id).all(),
      env.orders.prepare(
        "SELECT * FROM order_addons WHERE order_id = ? ORDER BY position"
      ).bind(saved.id).all(),
      env.orders.prepare(
        "SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id"
      ).bind(saved.id).all(),
      env.orders.prepare(
        "SELECT * FROM order_submissions WHERE order_id = ?"
      ).bind(saved.id).all()
    ]);

    expect(items.results).toHaveLength(1);
    expect(addons.results).toHaveLength(2);
    expect(addons.results.every((addon) => addon.currency === "USD")).toBe(true);
    expect(history.results.map((entry) => entry.to_status)).toEqual([
      "submitted",
      "validated"
    ]);
    expect(submissions.results).toHaveLength(1);
    expect(submissions.results[0]).toMatchObject({
      provider: "http",
      provider_submission_id: saved.public_id
    });
    expect(JSON.parse(submissions.results[0].payload).ordernumber).toBe("1234567890");
  });

  it("uses catalog prices instead of prices supplied by the client", async () => {
    await seedShop();
    mockCatalog();

    const { respond } = postJson(order({
      items: [{ sku: "coffeegrande", quantity: 1, price: 0.01 }]
    }));
    const response = await respond();
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.totals.subtotal).toBe(3.5);
    expect(body.totals.total).toBe(20.5);
  });

  it("rejects an unknown sku and records the order as invalid", async () => {
    await seedShop();
    mockCatalog();

    const { respond } = postJson(order({
      items: [{ sku: "does-not-exist", quantity: 1 }]
    }));
    const response = await respond();
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.status).toBe("invalid");
    expect(body.checks.some((check) => !check.passed && check.check.includes("sku"))).toBe(true);

    const saved = await readOrder();
    expect(saved.status).toBe("invalid");
    expect(saved.fulfillment_status).toBe("cancelled");

    const checks = await env.orders.prepare(
      "SELECT * FROM order_validation_checks WHERE order_id = ?"
    ).bind(saved.id).all();
    expect(checks.results.some((check) =>
      check.check_name === "item.sku" && check.passed === 0)).toBe(true);
  });

  it("requires a valid shipping option", async () => {
    await seedShop();
    mockCatalog();

    const { respond } = postJson(order({ shipping: { title: "Teleport" } }));
    const response = await respond();

    expect(response.status).toBe(422);
    expect((await response.json()).checks.some((check) =>
      !check.passed && check.check === "shipping")).toBe(true);
  });

  it("requires every configured custom option", async () => {
    await seedShop();
    mockCatalog();

    const { respond } = postJson(order({
      addons: [{ group: "Gift wrapping", value: "yes" }]
    }));
    const response = await respond();

    expect(response.status).toBe(422);
    expect((await response.json()).checks.some((check) =>
      !check.passed && check.check === "option.custom-engraving")).toBe(true);
  });

  it("does not validate when the catalog is unavailable", async () => {
    await seedShop();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));

    const { respond } = postJson(order());
    const response = await respond();

    expect(response.status).toBe(503);
    expect((await response.json()).status).toBe("unvalidated");
    expect(await readOrder()).toBe(null);
  });

  it("still accepts the no-javascript form with structured JSON order lines", async () => {
    await seedShop();
    mockCatalog();

    const body = new URLSearchParams({
      shop_id: "danimorrison",
      ordernumber: "form123",
      firstname: "Test",
      lastname: "User",
      email: "test@example.com",
      address: "1 Test Way",
      zipcode: "12345",
      city: "Testville",
      country: "USA",
      shipping: "Shipping World",
      "gift-wrapping": "yes",
      "custom-engraving": "no",
      order: JSON.stringify([{ sku: "coffeegrande", quantity: 1 }]),
      _next: "/payment/"
    });
    const { respond } = postForm(body);
    const response = await respond();

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/payment/`);

    const saved = await readOrder("form123");
    expect(saved.status).toBe("validated");
    expect(saved.total).toBe(20.5);
  });

  it("answers the order status endpoint without exposing the order", async () => {
    await seedShop();
    mockCatalog();
    await postJson(order()).respond();

    const response = await worker.fetch(new Request(
      `http://localhost:8787/order/status?shop_id=danimorrison&ordernumber=1234567890`
    ), env, createExecutionContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("validated");
    expect(body.validated).toBe(true);
    expect(body.total).toBe(24);
  });

  it("ships every structured column the worker writes", async () => {
    const ctx = createExecutionContext();
    const result = await env.orders.prepare("PRAGMA table_info(orders)").all();
    await waitOnExecutionContext(ctx);
    const columns = result.results.map((column) => column.name);

    for (const name of [
      "public_id", "currency", "subtotal", "shipping_cost",
      "addons_total", "total", "status", "fulfillment_status",
      "paid_amount", "paid_currency", "paid_exchange_rate"
    ]) {
      expect(columns).toContain(name);
    }
  });

  it("reports a missing schema as JSON before the shop lookup", async () => {
    mockSite();
    const response = await worker.fetch(new Request("http://localhost:8787/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN
      },
      body: JSON.stringify(order())
    }), envWithSchemaError(new Error("D1_ERROR: no such table: shops: SQLITE_ERROR")),
    createExecutionContext());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body.code).toBe("schema_out_of_date");
    expect(body.error).toMatch(/migrations/i);
  });

  it("reports an out-of-date schema instead of returning a generic error", async () => {
    mockSite();
    const response = await worker.fetch(new Request("http://localhost:8787/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN
      },
      body: JSON.stringify(order())
    }), envWithOrderInsertError(
      new Error("D1_ERROR: table orders has no column named schema_version")
    ), createExecutionContext());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.code).toBe("schema_out_of_date");
    expect(body.error).toMatch(/migrations/i);
  });
});

describe("submission providers", () => {
  it("returns the existing order for a repeated external submission", async () => {
    await seedShop();
    mockCatalog();
    const payload = order({
      provider: "typeform",
      provider_submission_id: "submission-123"
    });

    const first = await postJson(payload, ORIGIN, "/submissions").respond();
    const firstBody = await first.json();
    const second = await postJson(payload, ORIGIN, "/submissions").respond();
    const secondBody = await second.json();

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(secondBody.orderId).toBe(firstBody.orderId);

    const orders = await env.orders.prepare("SELECT * FROM orders").all();
    const submissions = await env.orders.prepare(
      "SELECT * FROM order_submissions"
    ).all();
    expect(orders.results).toHaveLength(1);
    expect(submissions.results).toHaveLength(1);
  });
});

describe("payment gates", () => {
  it("creates a Stripe checkout session with itemized lines and marks the order payment pending", async () => {
    await seedShop({ stripeSecretKey: "sk_test_key" });
    const stripeCalls = mockSiteWithStripe();

    const valid = await (await postJson(order()).respond()).json();
    const response = await checkoutRequest({
      shop_id: "danimorrison",
      order_id: valid.orderId
    }).respond();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toBe("https://checkout.stripe.com/test");
    expect(body.sessionId).toBe("cs_test_session");
    expect(body.status).toBe("payment_pending");
    expect(body.total).toBe(24);

    const saved = await readOrder();
    expect(saved.status).toBe("payment_pending");
    expect(saved.stripe_session_id).toBe("cs_test_session");

    expect(stripeCalls).toHaveLength(1);
    expect(stripeCalls[0].init.headers.Authorization).toBe("Bearer sk_test_key");
    const form = new URLSearchParams(stripeCalls[0].init.body);
    expect(form.get("mode")).toBe("payment");
    expect(form.get("client_reference_id")).toBe(String(valid.orderId));
    expect(form.get("customer_email")).toBe("test@example.com");
    expect(form.get("success_url")).toBe(`${ORIGIN}/thankyou/?stripe_session={CHECKOUT_SESSION_ID}`);
    expect(form.get("cancel_url")).toBe(`${ORIGIN}/payment/`);
    expect(form.get("metadata[order_id]")).toBe(String(valid.orderId));
    expect(form.get("metadata[ordernumber]")).toBe("1234567890");
    expect(form.get("metadata[shop_id]")).toBe("danimorrison");
    expect(form.get("line_items[0][price_data][currency]")).toBe("usd");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("350");
    expect(form.get("line_items[0][price_data][product_data][name]")).toBe("Buy me a coffee (grande)");
    expect(form.get("line_items[0][quantity]")).toBe("2");
    expect(form.get("line_items[1][price_data][unit_amount]")).toBe("200");
    expect(form.get("line_items[1][price_data][product_data][name]")).toBe("Gift wrapped");
    expect(form.get("line_items[1][quantity]")).toBe("1");
    expect(form.get("line_items[2][price_data][unit_amount]")).toBe("1500");
    expect(form.get("line_items[2][price_data][product_data][name]")).toBe("Shipping (Rest of the world)");
    expect(form.get("line_items[2][quantity]")).toBe("1");
    expect(form.get("line_items[3][price_data][unit_amount]")).toBe(null);
  });

  it("refuses a checkout session for an order that did not validate", async () => {
    await seedShop({ stripeSecretKey: "sk_test_key" });
    mockCatalog();

    await postJson(order({
      ordernumber: "invalid1",
      items: [{ sku: "does-not-exist", quantity: 1 }]
    })).respond();
    const rejected = await checkoutRequest({
      shop_id: "danimorrison",
      ordernumber: "invalid1"
    }).respond();

    expect(rejected.status).toBe(409);
    expect((await rejected.json()).status).toBe("invalid");
  });

  it("refuses a checkout session when card payments are not configured", async () => {
    await seedShop();
    mockCatalog();

    const valid = await (await postJson(order()).respond()).json();
    const response = await checkoutRequest({
      shop_id: "danimorrison",
      order_id: valid.orderId
    }).respond();

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("stripe_not_configured");
    expect((await readOrder()).status).toBe("validated");
  });

  it("leaves the order validated when Stripe rejects the session", async () => {
    await seedShop({ stripeSecretKey: "sk_test_key" });
    mockSiteWithStripe({ status: 402, error: "Card payments are unavailable" });

    const valid = await (await postJson(order()).respond()).json();
    const response = await checkoutRequest({
      shop_id: "danimorrison",
      order_id: valid.orderId
    }).respond();

    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("stripe_unavailable");

    const saved = await readOrder();
    expect(saved.status).toBe("validated");
    expect(saved.stripe_session_id).toBeNull();

    const history = await env.orders.prepare(
      "SELECT * FROM order_status_history WHERE order_id = ?"
    ).bind(saved.id).all();
    expect(history.results.map((entry) => entry.to_status)).toEqual([
      "submitted",
      "validated"
    ]);
  });

  it("creates a fresh session when checkout is repeated", async () => {
    await seedShop({ stripeSecretKey: "sk_test_key" });
    mockSiteWithStripe({
      sessions: [
        { id: "cs_test_one", url: "https://checkout.stripe.com/one" },
        { id: "cs_test_two", url: "https://checkout.stripe.com/two" }
      ]
    });

    const valid = await (await postJson(order()).respond()).json();
    const first = await checkoutRequest({
      shop_id: "danimorrison",
      order_id: valid.orderId
    }).respond();
    const second = await checkoutRequest({
      shop_id: "danimorrison",
      order_id: valid.orderId
    }).respond();

    expect((await first.json()).sessionId).toBe("cs_test_one");
    const body = await second.json();
    expect(second.status).toBe(200);
    expect(body.sessionId).toBe("cs_test_two");
    expect(body.url).toBe("https://checkout.stripe.com/two");
    expect(body.status).toBe("payment_pending");

    const saved = await readOrder();
    expect(saved.status).toBe("payment_pending");
    expect(saved.stripe_session_id).toBe("cs_test_two");

    const history = await env.orders.prepare(
      "SELECT * FROM order_status_history WHERE order_id = ? AND status_type = 'order'"
    ).bind(saved.id).all();
    expect(history.results.map((entry) => entry.to_status)).toEqual([
      "submitted",
      "validated",
      "payment_pending"
    ]);
  });

  it("completes a card payment from a checkout session to a paid webhook", async () => {
    await seedShop({ stripeSecretKey: "sk_test_key", stripeWebhookSecret: WEBHOOK_SECRET });
    mockSiteWithStripe();

    const valid = await (await postJson(order()).respond()).json();
    const session = await checkoutRequest({
      shop_id: "danimorrison",
      order_id: valid.orderId
    }).respond();
    expect((await session.json()).status).toBe("payment_pending");

    const paidEvent = {
      id: "evt_card_paid",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_session",
          currency: "usd",
          amount_total: 2400,
          client_reference_id: String(valid.orderId),
          metadata: { order_id: String(valid.orderId), shop_id: "danimorrison" }
        }
      }
    };
    const paid = await worker.fetch(
      await signedWebhookRequest(paidEvent),
      env,
      createExecutionContext()
    );
    expect(await paid.text()).toBe("ok");

    const saved = await readOrder();
    expect(saved.status).toBe("paid");
    expect(saved.payment_method).toBe("card");
    expect(saved.stripe_session_id).toBe("cs_test_session");
    expect(saved.paid_amount).toBe(24);
    expect(saved.paid_currency).toBe("USD");
  });

  it("marks an order paid from a webhook only after validation", async () => {
    await seedShop({ stripeWebhookSecret: WEBHOOK_SECRET });
    mockCatalog();

    const valid = await (await postJson(order()).respond()).json();
    const paidEvent = {
      id: "evt_valid",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_valid",
          currency: "usd",
          amount_total: 2400,
          client_reference_id: String(valid.orderId),
          metadata: { order_id: String(valid.orderId), shop_id: "danimorrison" }
        }
      }
    };
    const paid = await worker.fetch(
      await signedWebhookRequest(paidEvent),
      env,
      createExecutionContext()
    );
    expect(await paid.text()).toBe("ok");
    expect((await readOrder()).status).toBe("paid");

    const replay = await worker.fetch(
      await signedWebhookRequest(paidEvent),
      env,
      createExecutionContext()
    );
    expect(await replay.text()).toBe("ok");
    const events = await env.orders.prepare(
      "SELECT * FROM webhook_events WHERE event_id = ?"
    ).bind("evt_valid").all();
    expect(events.results).toHaveLength(1);
    expect(events.results[0].attempts).toBe(1);
    expect(events.results[0].processed_at).toBeTruthy();

    await postJson(order({
      ordernumber: "invalid2",
      items: [{ sku: "does-not-exist", quantity: 1 }]
    })).respond();
    const invalid = await readOrder("invalid2");
    const invalidEvent = {
      id: "evt_invalid",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_invalid",
          currency: "usd",
          amount_total: 2400,
          client_reference_id: String(invalid.id),
          metadata: { order_id: String(invalid.id), shop_id: "danimorrison" }
        }
      }
    };
    await worker.fetch(
      await signedWebhookRequest(invalidEvent),
      env,
      createExecutionContext()
    );
    expect((await readOrder("invalid2")).status).toBe("invalid");
  });

  it("refuses to claim an order that did not validate", async () => {
    await seedShop();
    mockCatalog();
    await postJson(order({
      ordernumber: "invalid3",
      items: [{ sku: "does-not-exist", quantity: 1 }]
    })).respond();

    const body = new URLSearchParams({
      form_type: "claim",
      shop_id: "danimorrison",
      ordernumber: "invalid3",
      email: "test@example.com",
      payment_method: "bank",
      _next: "/thankyou/"
    });
    const { respond } = postForm(body);
    const response = await respond();

    expect(response.status).toBe(409);
    expect((await readOrder("invalid3")).status).toBe("invalid");
  });

  it("claims a validated order and walks to the thank-you page", async () => {
    await seedShop();
    mockCatalog();
    await postJson(order()).respond();

    const body = new URLSearchParams({
      form_type: "claim",
      shop_id: "danimorrison",
      ordernumber: "1234567890",
      email: "test@example.com",
      payment_method: "bank",
      _next: "/thankyou/"
    });
    const { respond } = postForm(body);
    const response = await respond();

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/thankyou/`);
    expect((await readOrder()).status).toBe("claimed");

    const ctx = createExecutionContext();
    const claim = await env.orders.prepare("SELECT order_id, shop_id FROM claims").first();
    await waitOnExecutionContext(ctx);
    expect(claim.shop_id).toBe("danimorrison");
    expect(claim.order_id).toBeGreaterThan(0);

    const duplicate = await postForm(body).respond();
    expect(duplicate.status).toBe(409);
    const claims = await env.orders.prepare("SELECT * FROM claims").all();
    expect(claims.results).toHaveLength(1);
  });
});

describe("payment intents", () => {
  const intent = (overrides = {}) => ({
    shop_id: "danimorrison",
    ordernumber: "1234567890",
    payment_method: "paypal",
    method_label: "PayPal",
    source: "link",
    currency: "USD",
    ...overrides
  });

  async function readIntents() {
    const ctx = createExecutionContext();
    const rows = await env.orders.prepare(
      "SELECT * FROM payment_intents ORDER BY id"
    ).all();
    await waitOnExecutionContext(ctx);
    return rows.results;
  }

  it("records a payment intent for a validated order and sets its payment method", async () => {
    await seedShop();
    mockCatalog();
    await postJson(order()).respond();

    const { respond } = postJson(intent(), ORIGIN, "/payment-intent");
    const response = await respond();
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.paymentMethod).toBe("paypal");
    expect((await readOrder()).payment_method).toBe("paypal");

    const intents = await readIntents();
    expect(intents).toHaveLength(1);
    expect(intents[0].shop_id).toBe("danimorrison");
    expect(intents[0].ordernumber).toBe("1234567890");
    expect(intents[0].payment_method).toBe("paypal");
    expect(intents[0].method_label).toBe("PayPal");
    expect(intents[0].source).toBe("link");
    expect(intents[0].currency).toBe("USD");
    expect(intents[0].order_id).toBeGreaterThan(0);
    expect(intents[0].ip_hash).toBeNull();
    expect(intents[0].ua_hash).toBeNull();
  });

  it("hashes the requester ip and user agent", async () => {
    await seedShop();
    mockCatalog();
    await postJson(order()).respond();

    const request = new Request("http://localhost:8787/payment-intent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.7",
        "User-Agent": "test-agent/1.0"
      },
      body: JSON.stringify(intent())
    });
    const response = await worker.fetch(request, env, createExecutionContext());

    expect(response.status).toBe(201);
    const intents = await readIntents();
    expect(intents[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(intents[0].ua_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(intents[0].ip_hash).not.toBe(intents[0].ua_hash);
  });

  it("records every intent and keeps the latest payment method on the order", async () => {
    await seedShop();
    mockCatalog();
    await postJson(order()).respond();

    await postJson(intent(), ORIGIN, "/payment-intent").respond();
    await postJson(intent({
      payment_method: "crypto:xmr",
      method_label: "Monero (XMR)",
      source: "select",
      currency: "XMR"
    }), ORIGIN, "/payment-intent").respond();

    expect((await readIntents())).toHaveLength(2);
    expect((await readOrder()).payment_method).toBe("crypto:xmr");
  });

  it("rejects an intent for an unknown order", async () => {
    await seedShop();
    mockCatalog();

    const { respond } = postJson(
      intent({ ordernumber: "does-not-exist" }),
      ORIGIN,
      "/payment-intent"
    );
    const response = await respond();

    expect(response.status).toBe(404);
    expect(await readIntents()).toHaveLength(0);
  });

  it("rejects an intent missing required fields", async () => {
    await seedShop();
    mockCatalog();
    await postJson(order()).respond();

    const missingNumber = await postJson(
      intent({ ordernumber: "" }),
      ORIGIN,
      "/payment-intent"
    ).respond();
    expect(missingNumber.status).toBe(400);

    const missingMethod = await postJson(
      intent({ payment_method: "" }),
      ORIGIN,
      "/payment-intent"
    ).respond();
    expect(missingMethod.status).toBe(400);

    expect(await readIntents()).toHaveLength(0);
    expect((await readOrder()).payment_method).toBeNull();
  });
});

describe("shop authorization", () => {
  it("refuses an order submission for an unknown shop", async () => {
    await seedShop();
    mockCatalog();

    const response = await postJson(order({ shop_id: "intruder" })).respond();

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Unauthorized shop");
    expect((await countRows("orders"))).toBe(0);
  });

  it("refuses an order submission without a shop id", async () => {
    await seedShop();
    mockCatalog();

    const response = await postJson(order({ shop_id: "" })).respond();

    expect(response.status).toBe(403);
    expect((await countRows("orders"))).toBe(0);
  });

  it("refuses an order submission from a mismatched origin", async () => {
    await seedShop();
    mockCatalog();

    const response = await postJson(
      order(),
      "https://evil.example"
    ).respond();

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Unauthorized shop");
    expect((await countRows("orders"))).toBe(0);
  });

  it("accepts an order submission from a server without an origin header", async () => {
    await seedShop();
    mockCatalog();

    const response = await postJson(order(), null).respond();

    expect(response.status).toBe(201);
    expect((await readOrder()).shop_id).toBe("danimorrison");
  });

  it("refuses a claim for an unknown shop", async () => {
    await seedShop();
    mockCatalog();
    await postJson(order()).respond();

    const body = new URLSearchParams({
      form_type: "claim",
      shop_id: "intruder",
      ordernumber: "1234567890",
      email: "test@example.com",
      payment_method: "bank"
    });
    const response = await postForm(body).respond();

    expect(response.status).toBe(403);
    expect((await readOrder()).status).toBe("validated");
    expect((await countRows("claims"))).toBe(0);
  });

  it("refuses a payment intent for an unknown shop", async () => {
    await seedShop();
    mockCatalog();
    await postJson(order()).respond();

    const response = await postJson({
      shop_id: "intruder",
      ordernumber: "1234567890",
      payment_method: "paypal",
      source: "link"
    }, ORIGIN, "/payment-intent").respond();

    expect(response.status).toBe(403);
    expect((await countRows("payment_intents"))).toBe(0);
  });

  it("refuses a checkout session for an unknown shop", async () => {
    await seedShop();
    mockCatalog();
    const valid = await (await postJson(order()).respond()).json();

    const response = await worker.fetch(new Request(
      "http://localhost:8787/create-checkout-session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop_id: "intruder", order_id: valid.orderId })
      }
    ), env, createExecutionContext());

    expect(response.status).toBe(403);
    expect((await readOrder()).status).toBe("validated");
  });

  it("does not match orders across shops", async () => {
    await seedShop();
    await seedShop({
      id: "other-shop",
      origin: "https://other.example"
    });
    mockCatalog();
    const submitted = await (await postJson(
      order({ shop_id: "other-shop" }),
      "https://other.example"
    ).respond()).json();
    expect(submitted.success).toBe(true);

    const claim = new URLSearchParams({
      form_type: "claim",
      shop_id: "danimorrison",
      ordernumber: "1234567890",
      email: "test@example.com",
      payment_method: "bank"
    });
    const claimResponse = await postForm(claim).respond();
    expect(claimResponse.status).toBe(404);
    expect((await countRows("claims"))).toBe(0);

    const intentResponse = await postJson({
      shop_id: "danimorrison",
      ordernumber: "1234567890",
      payment_method: "paypal"
    }, ORIGIN, "/payment-intent").respond();
    expect(intentResponse.status).toBe(404);
    expect((await countRows("payment_intents"))).toBe(0);
  });
});

describe("webhook signatures", () => {
  const paidEvent = (orderId, shopId = "danimorrison") => ({
    id: "evt_sig_" + orderId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_" + orderId,
        currency: "usd",
        amount_total: 2400,
        client_reference_id: String(orderId),
        metadata: { order_id: String(orderId), shop_id: shopId }
      }
    }
  });

  it("refuses a webhook without a signature header", async () => {
    await seedShop({ stripeWebhookSecret: WEBHOOK_SECRET });
    mockCatalog();
    const valid = await (await postJson(order()).respond()).json();

    const response = await worker.fetch(
      await signedWebhookRequest(paidEvent(valid.orderId), { signed: false }),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(400);
    expect((await readOrder()).status).toBe("validated");
    expect((await countRows("webhook_events"))).toBe(0);
  });

  it("refuses a webhook signed with the wrong secret", async () => {
    await seedShop({ stripeWebhookSecret: WEBHOOK_SECRET });
    mockCatalog();
    const valid = await (await postJson(order()).respond()).json();

    const response = await worker.fetch(
      await signedWebhookRequest(paidEvent(valid.orderId), { secret: "whsec_wrong" }),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(400);
    expect((await readOrder()).status).toBe("validated");
    expect((await countRows("webhook_events"))).toBe(0);
  });

  it("refuses a stale webhook", async () => {
    await seedShop({ stripeWebhookSecret: WEBHOOK_SECRET });
    mockCatalog();
    const valid = await (await postJson(order()).respond()).json();

    const response = await worker.fetch(
      await signedWebhookRequest(paidEvent(valid.orderId), {
        timestamp: Math.floor(Date.now() / 1000) - 10 * 60
      }),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(400);
    expect((await readOrder()).status).toBe("validated");
    expect((await countRows("webhook_events"))).toBe(0);
  });

  it("accepts a webhook timestamped the way Stripe signs it, in seconds", async () => {
    await seedShop({ stripeWebhookSecret: WEBHOOK_SECRET });
    mockCatalog();
    const valid = await (await postJson(order()).respond()).json();

    const response = await worker.fetch(
      await signedWebhookRequest(paidEvent(valid.orderId), {
        timestamp: Math.floor(Date.now() / 1000) - 60
      }),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    expect((await readOrder()).status).toBe("paid");
    expect((await countRows("webhook_events"))).toBe(1);
  });

  it("refuses a webhook timestamped in milliseconds", async () => {
    await seedShop({ stripeWebhookSecret: WEBHOOK_SECRET });
    mockCatalog();
    const valid = await (await postJson(order()).respond()).json();

    const response = await worker.fetch(
      await signedWebhookRequest(paidEvent(valid.orderId), {
        timestamp: Date.now()
      }),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(400);
    expect((await readOrder()).status).toBe("validated");
    expect((await countRows("webhook_events"))).toBe(0);
  });

  it("refuses a webhook for a shop without a configured secret", async () => {
    await seedShop();
    mockCatalog();
    const valid = await (await postJson(order()).respond()).json();

    const response = await worker.fetch(
      await signedWebhookRequest(paidEvent(valid.orderId)),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(400);
    expect((await readOrder()).status).toBe("validated");
    expect((await countRows("webhook_events"))).toBe(0);
  });

  it("refuses a webhook for an unknown shop", async () => {
    await seedShop();
    mockCatalog();
    const valid = await (await postJson(order()).respond()).json();

    const response = await worker.fetch(
      await signedWebhookRequest(paidEvent(valid.orderId, "intruder"), {
        secret: "whsec_anything"
      }),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(403);
    expect((await readOrder()).status).toBe("validated");
    expect((await countRows("webhook_events"))).toBe(0);
  });
});
