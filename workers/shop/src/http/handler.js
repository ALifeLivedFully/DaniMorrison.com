import {
  OrderConflictError,
  OrderNotFoundError,
  OrderValidationError
} from "../services/order-service.js";

function submittingOrigin(request) {
  const header = request.headers.get("Origin");
  if (!header || header === "null") return null;
  try {
    return new URL(header).origin;
  } catch {
    return null;
  }
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) }
  });
}

function text(request, body, status = 200) {
  return new Response(body, { status, headers: corsHeaders(request) });
}

function databaseError(request, error) {
  const message = String(error?.message || error || "");
  const schema = /no column|no such column|has no column|no such table/i.test(message);
  return json(request, {
    error: schema
      ? "Order database schema is out of date. Apply the D1 migrations and try again."
      : "Could not save the order.",
    code: schema ? "schema_out_of_date" : "database_error"
  }, 500);
}

function serviceError(request, error) {
  if (error instanceof OrderNotFoundError) {
    return json(request, { error: error.message, code: error.code }, error.status);
  }
  if (error instanceof OrderConflictError) {
    return json(request, {
      error: error.message,
      code: error.code,
      ...(error.orderStatus ? { status: error.orderStatus } : {})
    }, error.status);
  }
  if (error instanceof OrderValidationError) {
    return json(request, { error: error.message, code: error.code }, error.status);
  }
  return null;
}

function formObject(form) {
  return Object.fromEntries([...form.entries()].map(([key, value]) => [
    key,
    typeof value === "string" ? value.trim() : value
  ]));
}

async function readBody(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    try {
      const value = await request.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("not an object");
      }
      return value;
    } catch {
      return null;
    }
  }
  if (contentType.includes("text/plain")) {
    try {
      const value = JSON.parse(await request.text());
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      return null;
    }
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      return formObject(await request.formData());
    } catch {
      return null;
    }
  }
  return null;
}

async function shopForRequest(shopStore, request, shopId) {
  if (!shopId) return null;
  const shop = await shopStore.findActiveById(shopId);
  if (!shop) return null;
  const origin = submittingOrigin(request);
  if (origin && String(shop.origin || "").replace(/\/+$/, "") !== origin.replace(/\/+$/, "")) {
    return null;
  }
  return shop;
}

async function shopConfig(shopStore, shop) {
  let cached = null;
  if (shop.config_cache) {
    try {
      cached = JSON.parse(shop.config_cache);
      if ("shipping" in cached && "custom_values" in cached) return cached;
    } catch {
      /* fall through to the site config */
    }
  }
  if (!shop.site_config_url) return cached;
  try {
    const response = await fetch(shop.site_config_url, {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return cached;
    const config = await response.json();
    if (shop.id) {
      try {
        await shopStore.updateConfigCache(shop.id, config);
      } catch {
        /* a cache write is an optimisation, not a requirement */
      }
    }
    return config;
  } catch {
    return cached;
  }
}

async function shopCatalog(shop, config) {
  const url = config.catalog_url || shop.catalog_url;
  if (!url) return null;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) return null;
  const catalog = await response.json();
  if (!catalog || !Array.isArray(catalog.items)) return null;
  return catalog;
}

const STRIPE_SESSIONS_URL = "https://api.stripe.com/v1/checkout/sessions";

function stripeCents(amount) {
  return Math.round(Number(amount || 0) * 100);
}

function itemLineName(item) {
  const title = String(item.title || "").trim();
  const variant = String(item.variant || "").trim();
  if (title && variant) return `${title} (${variant})`;
  return title || variant || "Item";
}

function checkoutLines(order, items, addons) {
  const lines = [];
  for (const item of Array.isArray(items) ? items : []) {
    const amount = stripeCents(item.unit_price);
    const quantity = Math.trunc(Number(item.quantity) || 0);
    if (!(amount > 0) || !(quantity > 0)) continue;
    lines.push({ name: itemLineName(item), amount, quantity });
  }
  for (const addon of Array.isArray(addons) ? addons : []) {
    const amount = stripeCents(addon.price);
    if (!(amount > 0)) continue;
    const name = String(addon.title || addon.group || "Option").trim() || "Option";
    lines.push({ name, amount, quantity: 1 });
  }
  const shipping = stripeCents(order.shipping_cost);
  if (shipping > 0) {
    const label = String(order.shipping_label || order.shipping_title || "").trim();
    lines.push({ name: label ? `Shipping (${label})` : "Shipping", amount: shipping, quantity: 1 });
  }
  return lines;
}

function stripeCheckoutForm(shop, order, items, addons) {
  const base = String(shop.origin || "").replace(/\/+$/, "");
  const fields = [
    ["mode", "payment"],
    ["success_url", `${base}/thankyou/?stripe_session={CHECKOUT_SESSION_ID}`],
    ["cancel_url", `${base}/payment/`],
    ["client_reference_id", String(order.id)],
    ["metadata[order_id]", String(order.id)],
    ["metadata[ordernumber]", String(order.ordernumber || "")],
    ["metadata[shop_id]", String(order.shop_id || "")]
  ];
  if (order.email) fields.push(["customer_email", String(order.email)]);

  const currency = String(order.currency || "USD").toLowerCase();
  const totalCents = stripeCents(order.total);
  let lines = checkoutLines(order, items, addons);
  const summed = lines.reduce((sum, line) => sum + line.amount * line.quantity, 0);
  if (!lines.length || summed !== totalCents) {
    lines = [{
      name: `Order ${order.ordernumber || order.id}`,
      amount: totalCents,
      quantity: 1
    }];
  }
  lines.forEach((line, index) => {
    fields.push(
      [`line_items[${index}][price_data][currency]`, currency],
      [`line_items[${index}][price_data][unit_amount]`, String(line.amount)],
      [`line_items[${index}][price_data][product_data][name]`, line.name],
      [`line_items[${index}][quantity]`, String(line.quantity)]
    );
  });
  return new URLSearchParams(fields).toString();
}

async function createStripeSession(secretKey, form) {
  const response = await fetch(STRIPE_SESSIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload || !payload.id || !payload.url) {
    const detail = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Stripe rejected the checkout session: ${detail}`);
  }
  return payload;
}

export function createHandler({ orderService, shopStore }) {
  async function orderStatus(request) {
    const url = new URL(request.url);
    const shopId = String(url.searchParams.get("shop_id") || "").trim();
    const ordernumber = String(url.searchParams.get("ordernumber") || "").trim();
    if (!ordernumber) return json(request, { error: "ordernumber is required" }, 400);

    const order = await orderService.status({ shopId, ordernumber });
    if (!order) return json(request, { error: "order not found" }, 404);
    return json(request, {
      orderId: order.id,
      orderPublicId: order.public_id,
      ordernumber: order.ordernumber,
      status: order.status,
      fulfillmentStatus: order.fulfillment_status,
      validated: order.status === "validated",
      currency: order.currency,
      subtotal: order.subtotal,
      shipping: order.shipping_cost,
      addons: order.addons_total,
      total: order.total,
      validatedAt: order.validated_at
    });
  }

  async function submitOrder(request, { external = false } = {}) {
    const contentType = request.headers.get("Content-Type") || "";
    const isForm = contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data");
    const data = await readBody(request);
    if (!data) return text(request, "Invalid data", 400);

    if (data._gotcha) return text(request, "Submission received");
    if (String(data.form_type || "") === "claim") {
      return handleClaim(request, data);
    }

    const shopId = String(data.shop_id ?? data.shopId ?? "").trim();
    const shop = await shopForRequest(shopStore, request, shopId);
    if (!shop) return text(request, "Unauthorized shop", 403);

    let config = null;
    let catalog = null;
    try {
      config = await shopConfig(shopStore, shop);
      if (config) catalog = await shopCatalog(shop, config);
    } catch (error) {
      console.error("Shop lookup failed:", error);
    }
    if (!config || !catalog) {
      return json(request, {
        error: "Shop catalog is unavailable; the order was not validated",
        status: "unvalidated"
      }, 503);
    }

    const browserOrigin = submittingOrigin(request);
    const next = new URL(String(data._next ?? "/"), browserOrigin || request.url);
    const provider = external
      ? String(data.provider ?? "").trim()
      : "http";
    const providerSubmissionId = external
      ? String(data.provider_submission_id ?? data.submission_id ?? "").trim()
      : undefined;

    if (external && (!provider || !providerSubmissionId)) {
      return json(request, {
        error: "provider and provider_submission_id are required",
        code: "missing_submission_identity"
      }, 400);
    }

    try {
      const result = await orderService.submit({
        data,
        config,
        catalog,
        shopId,
        nextUrl: next.href,
        provider,
        providerSubmissionId,
        submissionPayload: data,
        source: external ? "external" : (isForm ? "form" : "json")
      });
      const { order, validation, duplicate } = result;
      const valid = duplicate
        ? order.status === "validated"
        : validation.valid;
      const response = {
        success: valid,
        orderId: order.id,
        orderPublicId: order.public_id,
        ordernumber: validation.ordernumber,
        status: order.status,
        fulfillmentStatus: order.fulfillment_status,
        validated: valid,
        totals: duplicate
          ? {
              subtotal: order.subtotal,
              shipping: order.shipping_cost,
              addons: order.addons_total,
              total: order.total,
              currency: order.currency
            }
          : validation.totals,
        checks: duplicate ? [] : validation.checks
      };

      if (!valid) return json(request, response, 422);
      if (external) return json(request, response, duplicate ? 200 : 201);
      if (isForm && browserOrigin && next.pathname === "/payment/") {
        return Response.redirect(next.href, 303);
      }
      return json(request, response, duplicate ? 200 : 201);
    } catch (error) {
      console.error("Order submission failed:", error);
      return serviceError(request, error) || databaseError(request, error);
    }
  }

  async function createCheckoutSession(request) {
    const data = await readBody(request);
    if (!data) return text(request, "Invalid data", 400);

    const shopId = String(data.shop_id ?? data.shopId ?? "").trim();
    const orderId = Number(data.order_id ?? data.orderId ?? 0);
    const ordernumber = String(data.ordernumber ?? "").trim();
    if (!orderId && !ordernumber) {
      return json(request, { error: "order_id or ordernumber is required" }, 400);
    }
    const shop = await shopForRequest(shopStore, request, shopId);
    if (!shop) return text(request, "Unauthorized shop", 403);
    if (!shop.stripe_secret_key) {
      return json(request, {
        error: "Card payments are not configured for this shop",
        code: "stripe_not_configured"
      }, 400);
    }

    let prepared;
    try {
      prepared = await orderService.prepareCheckout({ shopId, orderId, ordernumber });
    } catch (error) {
      return serviceError(request, error) || databaseError(request, error);
    }
    const { order, items, addons } = prepared;

    let session;
    try {
      session = await createStripeSession(
        shop.stripe_secret_key,
        stripeCheckoutForm(shop, order, items, addons)
      );
    } catch (error) {
      console.error("Stripe checkout session failed:", error);
      return json(request, {
        error: "Could not create the card payment session. The order was not charged.",
        code: "stripe_unavailable"
      }, 502);
    }

    let updated;
    try {
      updated = await orderService.beginCheckout(order.id, session.id);
    } catch (error) {
      return serviceError(request, error) || databaseError(request, error);
    }
    return json(request, {
      url: session.url,
      sessionId: session.id,
      orderId: order.id,
      orderPublicId: order.public_id,
      ordernumber: order.ordernumber,
      status: updated.status,
      fulfillmentStatus: updated.fulfillment_status,
      total: order.total,
      currency: order.currency
    });
  }

function parseStripeSignature(header) {
  const timestamps = [];
  const signatures = [];
  String(header || "").split(",").forEach((piece) => {
    const index = piece.indexOf("=");
    if (index < 1) return;
    const key = piece.slice(0, index).trim();
    const value = piece.slice(index + 1).trim();
    if (key === "t") timestamps.push(value);
    if (key === "v1") signatures.push(value);
  });
  return { timestamp: timestamps[0] || "", signatures };
}

async function hmacSha256(secret, value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

async function handleWebhook(request) {
  const raw = await request.text();
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return text(request, "Invalid webhook", 400);
  }
  if (!event || typeof event !== "object") {
    return text(request, "Invalid webhook", 400);
  }

  const shopId = String(event?.data?.object?.metadata?.shop_id || "").trim();
  const shop = await shopForRequest(shopStore, request, shopId);
  if (!shop) return text(request, "Unauthorized shop", 403);
  if (!shop.stripe_webhook_secret) {
    return text(request, "Webhooks are not configured for this shop", 400);
  }

  const { timestamp, signatures } = parseStripeSignature(request.headers.get("Stripe-Signature"));
  const issuedMs = Number(timestamp) * 1000; /* Stripe writes t in seconds */
  const tolerance = 5 * 60 * 1000;
  if (!signatures.length || !Number.isFinite(issuedMs) || Math.abs(Date.now() - issuedMs) > tolerance) {
    return text(request, "Invalid webhook signature", 400);
  }
  const expected = await hmacSha256(shop.stripe_webhook_secret, `${timestamp}.${raw}`);
  if (!signatures.some((signature) => timingSafeEqual(signature, expected))) {
    return text(request, "Invalid webhook signature", 400);
  }

  try {
    await orderService.handleWebhook({
      provider: String(event.provider || "stripe"),
      event
    });
    return text(request, "ok");
  } catch (error) {
    return serviceError(request, error) || databaseError(request, error);
  }
}

  async function handleClaim(request, body) {
    const data = body || await readBody(request);
    if (!data) return text(request, "Invalid data", 400);

    const shopId = String(data.shop_id ?? data.shopId ?? "").trim();
    const shop = await shopForRequest(shopStore, request, shopId);
    if (!shop) return text(request, "Unauthorized shop", 403);
    const claim = {
      ordernumber: String(data.ordernumber ?? "").trim(),
      email: String(data.email ?? "").trim(),
      message: String(data.message ?? "").trim(),
      paymentMethod: String(data.payment_method ?? "").trim()
    };

    try {
      await orderService.claim({ shopId, ...claim });
    } catch (error) {
      return serviceError(request, error) || text(request, "Could not save claim", 500);
    }

    const browserOrigin = submittingOrigin(request);
    if (browserOrigin) {
      const next = new URL(String(data._next ?? "/"), browserOrigin);
      if (next.pathname.includes("thank")) {
        return Response.redirect(next.href, 303);
      }
    }
    return text(request, "Claim submitted successfully", 201);
  }

  async function handlePaymentIntent(request) {
    const data = await readBody(request);
    if (!data) return text(request, "Invalid data", 400);

    const shopId = String(data.shop_id ?? data.shopId ?? "").trim();
    const shop = await shopForRequest(shopStore, request, shopId);
    if (!shop) return text(request, "Unauthorized shop", 403);

    async function hash(value) {
      if (!value) return null;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }

    try {
      const order = await orderService.recordIntent({
        shopId,
        ordernumber: String(data.ordernumber ?? "").trim(),
        paymentMethod: String(data.payment_method ?? "").trim(),
        methodLabel: String(data.method_label ?? "").trim() || null,
        source: String(data.source ?? "").trim() || "link",
        currency: String(data.currency ?? "").trim() || null,
        ipHash: await hash(request.headers.get("CF-Connecting-IP")),
        uaHash: await hash(request.headers.get("User-Agent"))
      });
      return json(request, {
        orderId: order.id,
        ordernumber: order.ordernumber,
        status: order.status,
        paymentMethod: order.payment_method
      }, 201);
    } catch (error) {
      return serviceError(request, error) || databaseError(request, error);
    }
  }

  return async function handle(request) {
    try {
      const url = new URL(request.url);
      const method = request.method;

      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }

      if (method === "GET" && url.pathname === "/health") {
        return json(request, { status: "ok" });
      }

      if (method === "GET" && url.pathname === "/order/status") {
        return await orderStatus(request);
      }

      if (method === "POST" && (url.pathname === "/" || url.pathname === "/order")) {
        return await submitOrder(request);
      }

      if (method === "POST" && url.pathname === "/submissions") {
        return await submitOrder(request, { external: true });
      }

      if (method === "POST" && url.pathname === "/create-checkout-session") {
        return await createCheckoutSession(request);
      }

      if (method === "POST" && url.pathname === "/webhook") {
        return await handleWebhook(request);
      }

      if (method === "POST" && url.pathname === "/claim") {
        return await handleClaim(request);
      }

      if (method === "POST" && url.pathname === "/payment-intent") {
        return await handlePaymentIntent(request);
      }

      if (method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET, POST, OPTIONS", ...corsHeaders(request) }
        });
      }

      return new Response("Not found", { status: 404, headers: corsHeaders(request) });
    } catch (error) {
      console.error("Unhandled worker error:", error);
      return serviceError(request, error) || databaseError(request, error);
    }
  };
}
