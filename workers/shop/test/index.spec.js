import { env, createExecutionContext, waitOnExecutionContext, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src";

/* A complete order body; tests tweak individual fields. */
const order = (overrides = {}) => new URLSearchParams({
  shop_id: "danimorrison",
  ordernumber: "1234567890",
  firstname: "Test",
  lastname: "User",
  email: "test@example.com",
  address: "1 Test Way",
  zipcode: "12345",
  city: "Testville",
  shipping: "Shipping World",
  country: "USA",
  "gift-wrapping": "no",
  "custom-engraving": "no",
  order: "1 x Beer = $2.75",
  checkout: "Shopping cart: $2.75 | Shipping World: $15.00 | Payment total: $17.75",
  _next: "/payment/",
  ...overrides
});

const post = (body, origin) => {
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
};

beforeEach(async () => {
  const ctx = createExecutionContext();
  await env.orders.prepare("DELETE FROM orders").run();
  await waitOnExecutionContext(ctx);
});

describe("the order worker", () => {
  it("refuses anything but a form post", async () => {
    const response = await SELF.fetch("http://localhost:8787");
    expect(response.status).toBe(405);
  });

  it("refuses a non-form content type", async () => {
    const request = new Request("http://localhost:8787/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response.status).toBe(415);
  });

  it("falls for the honeypot before anything else", async () => {
    const { respond } = post(order({ _gotcha: "i am a bot" }));
    const response = await respond();
    expect(await response.text()).toBe("Submission received");
  });

  it("stores the order with its shop and resolves `_next` from the Origin", async () => {
    const { respond } = post(order(), "http://localhost:1313");
    const response = await respond();

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("http://localhost:1313/payment/");
    expect(await next_url()).toBe("http://localhost:1313/payment/");
  });

  it("resolves `_next` against a production Origin just the same", async () => {
    const { respond } = post(order({ email: "prod@example.com" }), "https://danimorrison.com");
    const response = await respond();

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("https://danimorrison.com/payment/");
    expect(await next_url(["email = 'prod@example.com'"])).toBe("https://danimorrison.com/payment/");
  });

  it("answers a post without a browser Origin with the plain receipt", async () => {
    const { respond } = post(order({ email: "plain@example.com" }));
    const response = await respond();

    expect(response.status).toBe(201);
    expect(response.headers.get("Location")).toBe(null);
    expect(await next_url(["email = 'plain@example.com'"])).toBe("http://localhost:8787/payment/");
  });

  it("tolerates a null Origin (a file:// page) without breaking", async () => {
    const { request, respond } = post(order({ email: "file@example.com" }));
    request.headers.set("Origin", "null");
    const response = await respond();

    expect(response.status).toBe(201);
    expect(response.headers.get("Location")).toBe(null);
  });

  it("claims an order and walks to the thank-you page on the site's own origin", async () => {
    const { respond } = post(order(), "http://localhost:1313");
    await respond();

    const claimBody = new URLSearchParams({
      form_type: "claim",
      shop_id: "danimorrison",
      ordernumber: "1234567890",
      email: "test@example.com",
      payment_method: "bank",
      _next: "/thankyou/"
    });
    const claim = post(claimBody, "http://localhost:1313");
    const response = await claim.respond();

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("http://localhost:1313/thankyou/");

    const ctx = createExecutionContext();
    const saved = await env.orders.prepare(
      "SELECT status, payment_method, shop_id FROM orders WHERE ordernumber = ?"
    ).bind("1234567890").first();
    await waitOnExecutionContext(ctx);

    expect(saved.status).toBe("claimed");
    expect(saved.payment_method).toBe("bank");
    expect(saved.shop_id).toBe("danimorrison");

    const claimCtx = createExecutionContext();
    const row = await env.orders.prepare("SELECT order_id, shop_id FROM claims").first();
    await waitOnExecutionContext(claimCtx);

    expect(row.shop_id).toBe("danimorrison");
    expect(row.order_id).toBeGreaterThan(0);
  });

  it("refuses a claim without its order number", async () => {
    const claimBody = new URLSearchParams({
      form_type: "claim",
      shop_id: "danimorrison",
      email: "test@example.com",
      _next: "/thankyou/"
    });
    const { respond } = post(claimBody, "http://localhost:1313");
    const response = await respond();
    expect(response.status).toBe(400);
  });
});

async function next_url(wheres = ["email = 'test@example.com'"]) {
  const ctx = createExecutionContext();
  const row = await env.orders.prepare(
    "SELECT next_url FROM orders WHERE " + wheres.join(" AND ")
  ).first();
  await waitOnExecutionContext(ctx);
  return row?.next_url;
}
