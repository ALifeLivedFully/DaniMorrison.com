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
    INSERT INTO shops (id, origin, site_config_url, catalog_url, active, config_cache)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    overrides.id ?? "danimorrison",
    overrides.origin ?? ORIGIN,
    overrides.site_config_url ?? `${ORIGIN}/payment.json`,
    overrides.catalog_url ?? CATALOG_URL,
    overrides.active ?? 1,
    overrides.config_cache ?? JSON.stringify(overrides.config ?? config)
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

function envWithOrderInsertError(error) {
  const run = async (sql) => {
    if (sql.includes("INSERT INTO orders")) throw error;
    return { meta: { last_row_id: 1 } };
  };
  return {
    orders: {
      prepare(sql) {
        const bound = {
          first: async () => null,
          all: async () => ({ results: [] }),
          run: () => run(sql),
          __run: () => run(sql)
        };
        return {
          bind: () => bound,
          first: async () => null,
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

async function readOrder(ordernumber = "1234567890") {
  const ctx = createExecutionContext();
  const row = await env.orders.prepare(
    "SELECT * FROM orders WHERE ordernumber = ? ORDER BY id DESC LIMIT 1"
  ).bind(ordernumber).first();
  await waitOnExecutionContext(ctx);
  return row;
}

beforeEach(async () => {
  const ctx = createExecutionContext();
  await env.orders.prepare("DELETE FROM order_validation_checks").run();
  await env.orders.prepare("DELETE FROM order_addons").run();
  await env.orders.prepare("DELETE FROM order_items").run();
  await env.orders.prepare("DELETE FROM order_status_history").run();
  await env.orders.prepare("DELETE FROM order_submissions").run();
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
  it("creates a checkout session only for a validated order", async () => {
    await seedShop();
    mockCatalog();

    const valid = await (await postJson(order()).respond()).json();
    const accepted = await worker.fetch(new Request(
      "http://localhost:8787/create-checkout-session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop_id: "danimorrison",
          order_id: valid.orderId
        })
      }
    ), env, createExecutionContext());

    expect(accepted.status).toBe(200);
    expect((await accepted.json()).status).toBe("payment_pending");

    await postJson(order({
      ordernumber: "invalid1",
      items: [{ sku: "does-not-exist", quantity: 1 }]
    })).respond();
    const rejected = await worker.fetch(new Request(
      "http://localhost:8787/create-checkout-session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop_id: "danimorrison",
          ordernumber: "invalid1"
        })
      }
    ), env, createExecutionContext());

    expect(rejected.status).toBe(409);
    expect((await rejected.json()).status).toBe("invalid");
  });

  it("keeps checkout creation idempotent", async () => {
    await seedShop();
    mockCatalog();

    const valid = await (await postJson(order()).respond()).json();
    const request = () => new Request(
      "http://localhost:8787/create-checkout-session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop_id: "danimorrison",
          order_id: valid.orderId
        })
      }
    );
    await worker.fetch(request(), env, createExecutionContext());
    const second = await worker.fetch(request(), env, createExecutionContext());
    const body = await second.json();

    expect(second.status).toBe(200);
    expect(body.status).toBe("payment_pending");
  });

  it("marks an order paid from a webhook only after validation", async () => {
    await seedShop();
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
          metadata: { order_id: String(valid.orderId) }
        }
      }
    };
    const paid = await worker.fetch(new Request("http://localhost:8787/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(paidEvent)
    }), env, createExecutionContext());
    expect(await paid.text()).toBe("ok");
    expect((await readOrder()).status).toBe("paid");

    const replay = await worker.fetch(new Request("http://localhost:8787/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(paidEvent)
    }), env, createExecutionContext());
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
          metadata: { order_id: String(invalid.id) }
        }
      }
    };
    await worker.fetch(new Request("http://localhost:8787/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invalidEvent)
    }), env, createExecutionContext());
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
