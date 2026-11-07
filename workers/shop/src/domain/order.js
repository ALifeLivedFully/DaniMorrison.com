export const ORDER_STATUS = Object.freeze({
  SUBMITTED: "submitted",
  VALIDATED: "validated",
  INVALID: "invalid",
  PAYMENT_PENDING: "payment_pending",
  CLAIMED: "claimed",
  PAID: "paid"
});

export const FULFILLMENT_STATUS = Object.freeze({
  UNFULFILLED: "unfulfilled",
  FULFILLMENT_PENDING: "fulfillment_pending",
  FULFILLED: "fulfilled",
  CANCELLED: "cancelled"
});

export const ORDER_TRANSITIONS = Object.freeze({
  submitted: ["validated", "invalid"],
  validated: ["payment_pending", "claimed", "paid"],
  payment_pending: ["paid", "claimed"],
  claimed: ["paid"],
  invalid: [],
  paid: []
});

export const FULFILLMENT_TRANSITIONS = Object.freeze({
  unfulfilled: ["fulfillment_pending", "cancelled"],
  fulfillment_pending: ["fulfilled", "cancelled"],
  fulfilled: [],
  cancelled: []
});

export const CUSTOMER_FIELDS = [
  "firstname", "lastname", "email", "address",
  "zipcode", "city", "country"
];

export function canTransitionOrderStatus(from, to) {
  return Boolean(ORDER_TRANSITIONS[from]?.includes(to));
}

export function canTransitionFulfillmentStatus(from, to) {
  return Boolean(FULFILLMENT_TRANSITIONS[from]?.includes(to));
}

export function assertOrderTransition(from, to) {
  if (!canTransitionOrderStatus(from, to)) {
    throw new Error(`invalid order status transition: ${from} -> ${to}`);
  }
}

export function assertFulfillmentTransition(from, to) {
  if (!canTransitionFulfillmentStatus(from, to)) {
    throw new Error(`invalid fulfillment status transition: ${from} -> ${to}`);
  }
}

export function newPublicId() {
  return globalThis.crypto.randomUUID();
}

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function roundRate(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e8) / 1e8;
}

export function normalizeGroup(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function customerFrom(data) {
  const customer = data.customer && typeof data.customer === "object"
    ? data.customer
    : data;
  const result = {};
  for (const field of CUSTOMER_FIELDS) {
    result[field] = String(customer[field] ?? data[field] ?? "").trim();
  }
  result.message = String(data.message ?? "").trim();
  return result;
}

function requestedItems(data) {
  const source = Array.isArray(data.items) ? data.items : parseJsonArray(data.order);
  return source.map((item) => {
    if (typeof item === "string") return { sku: item.trim(), quantity: 1 };
    return {
      sku: String(item?.sku ?? item?.id ?? "").trim(),
      quantity: Number(item?.quantity ?? item?.qty ?? 1)
    };
  }).filter((item) => item.sku);
}

function requestedOptions(data, config) {
  const provided = new Map();
  const add = (group, value) => {
    const key = normalizeGroup(group);
    if (key) provided.set(key, String(value ?? "").trim());
  };

  if (Array.isArray(data.addons)) {
    for (const addon of data.addons) {
      add(addon?.group ?? addon?.title ?? addon?.name, addon?.value ?? addon?.option);
    }
  } else if (data.addons && typeof data.addons === "object") {
    for (const [group, value] of Object.entries(data.addons)) add(group, value);
  }

  const custom = data.custom_values && typeof data.custom_values === "object"
    ? data.custom_values
    : {};
  if (Array.isArray(custom)) {
    for (const addon of custom) {
      add(addon?.group ?? addon?.title ?? addon?.name, addon?.value ?? addon?.option);
    }
  } else {
    for (const [group, value] of Object.entries(custom)) add(group, value);
  }

  for (const [group, value] of Object.entries(data)) {
    const known = new Set([
      "shop_id", "ordernumber", "order", "items", "shipping", "addons",
      "custom_values", "customer", "message", "_next", "_token", "_gotcha",
      "form_type", ...CUSTOMER_FIELDS
    ]);
    if (known.has(group)) continue;
    if (config.custom_values?.some((entry) =>
      normalizeGroup(entry.title) === normalizeGroup(group))) {
      add(group, value);
    }
  }

  return provided;
}

function catalogIndex(catalog) {
  const index = new Map();
  for (const item of catalog.items || []) {
    if (!item || !item.sku) continue;
    index.set(String(item.sku), { item, variant: null });
    for (const variant of item.variants || []) {
      if (variant?.sku) index.set(String(variant.sku), { item, variant });
    }
  }
  return index;
}

function validateCustomer(customer, checks) {
  for (const field of CUSTOMER_FIELDS) {
    if (!customer[field]) {
      checks.push({
        check: `customer.${field}`,
        passed: false,
        message: `${field} is required`
      });
    }
  }
  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    checks.push({
      check: "customer.email",
      passed: false,
      message: "email address is invalid"
    });
  }
}

export function validateOrder(data, config, catalog) {
  const checks = [];
  const customer = customerFrom(data);
  validateCustomer(customer, checks);

  const ordernumber = String(data.ordernumber ?? "").trim();
  if (!ordernumber || !/^[A-Za-z0-9_-]{1,64}$/.test(ordernumber)) {
    checks.push({
      check: "ordernumber",
      passed: false,
      message: "ordernumber is required and must be alphanumeric"
    });
  }

  const currency = String(
    config.currency?.code || config.currency?.shop || "USD"
  ).toUpperCase();
  const items = catalogIndex(catalog);
  const requested = requestedItems(data);
  const merged = new Map();
  const lines = [];

  if (!requested.length) {
    checks.push({ check: "items", passed: false, message: "at least one item is required" });
  }

  for (const request of requested) {
    const entry = items.get(request.sku);
    if (!entry) {
      checks.push({
        check: "item.sku",
        passed: false,
        message: `sku ${request.sku} is not in the shop catalog`
      });
      continue;
    }
    if (entry.item.available === false) {
      checks.push({
        check: "item.sku",
        passed: false,
        message: `sku ${request.sku} is not available`
      });
      continue;
    }
    const price = Number(entry.variant ? entry.variant.price : entry.item.price);
    if (!Number.isFinite(price) || price < 0) {
      checks.push({
        check: "item.price",
        passed: false,
        message: `sku ${request.sku} has no valid price`
      });
      continue;
    }
    if (!Number.isInteger(request.quantity) || request.quantity < 1) {
      checks.push({
        check: "item.quantity",
        passed: false,
        message: `quantity for ${request.sku} must be a positive integer`
      });
      continue;
    }
    const existing = merged.get(request.sku);
    if (existing) {
      existing.quantity += request.quantity;
    } else {
      const line = {
        sku: request.sku,
        title: String(entry.item.title || ""),
        variant: entry.variant ? String(entry.variant.name || "") : "",
        quantity: request.quantity,
        unit_price: roundMoney(price),
        line_total: roundMoney(price * request.quantity),
        currency
      };
      merged.set(request.sku, line);
      lines.push(line);
    }
  }

  for (const line of lines) {
    if (line.quantity > 999) {
      checks.push({
        check: `item.${line.sku}`,
        passed: false,
        message: "quantity is too large"
      });
    }
    line.line_total = roundMoney(line.unit_price * line.quantity);
  }

  const shippingConfig = config.shipping || {};
  let shipping = { title: "", label: "", price: 0 };
  if (shippingConfig.active) {
    const requestedShipping = typeof data.shipping === "string"
      ? data.shipping.trim()
      : String(data.shipping?.title ?? data.shipping?.option ?? "").trim();
    const option = (shippingConfig.options || []).find((entry) =>
      String(entry.title) === requestedShipping ||
      String(entry.label) === requestedShipping
    );
    if (!option) {
      checks.push({
        check: "shipping",
        passed: false,
        message: "a valid shipping option is required"
      });
    } else {
      const price = Number(option.price);
      if (!Number.isFinite(price) || price < 0) {
        checks.push({
          check: "shipping",
          passed: false,
          message: "shipping option has no valid price"
        });
      } else {
        shipping = {
          title: String(option.title || ""),
          label: String(option.label || option.title || ""),
          price: roundMoney(price)
        };
      }
    }
  }

  const providedOptions = requestedOptions(data, config);
  const matchedOptions = new Set();
  const addons = [];
  for (const group of config.custom_values || []) {
    const key = normalizeGroup(group.title);
    if (!key) continue;
    if (!providedOptions.has(key) || !providedOptions.get(key)) {
      checks.push({
        check: `option.${key}`,
        passed: false,
        message: `${group.title} is required`
      });
      continue;
    }
    matchedOptions.add(key);
    const value = providedOptions.get(key);
    const option = (group.options || []).find((entry) =>
      String(entry.value) === value
    );
    if (!option) {
      checks.push({
        check: `option.${key}`,
        passed: false,
        message: `${group.title} has an unknown value`
      });
      continue;
    }
    const price = Number(option.price || 0);
    if (!Number.isFinite(price) || price < 0) {
      checks.push({
        check: `option.${key}`,
        passed: false,
        message: `${group.title} has no valid price`
      });
      continue;
    }
    addons.push({
      group: String(group.title || ""),
      value: String(option.value ?? ""),
      title: String(option.title || ""),
      price: roundMoney(price)
    });
  }
  for (const key of providedOptions.keys()) {
    if (!matchedOptions.has(key)) {
      checks.push({
        check: `option.${key}`,
        passed: false,
        message: "unknown option"
      });
    }
  }

  const subtotal = roundMoney(lines.reduce((sum, line) => sum + line.line_total, 0));
  const addonsTotal = roundMoney(addons.reduce((sum, addon) => sum + addon.price, 0));
  const total = roundMoney(subtotal + shipping.price + addonsTotal);
  const valid = checks.every((check) => check.passed);

  return {
    valid,
    checks,
    customer,
    ordernumber,
    items: lines,
    shipping,
    addons,
    totals: {
      subtotal,
      shipping: shipping.price,
      addons: addonsTotal,
      total,
      currency
    },
    requested_items: requested
  };
}

export function calculatePaidExchangeRate({
  total,
  currency,
  paidAmount,
  paidCurrency,
  providerRate
}) {
  const shopCurrency = String(currency || "").toUpperCase();
  const paymentCurrency = String(paidCurrency || "").toUpperCase();
  if (!shopCurrency || !paymentCurrency) {
    return { rate: null, source: null };
  }
  if (shopCurrency === paymentCurrency) {
    return { rate: 1, source: "same_currency" };
  }
  if (Number.isFinite(Number(providerRate)) && Number(providerRate) > 0) {
    return { rate: roundRate(providerRate), source: "provider" };
  }
  if (Number(total) > 0 && Number.isFinite(Number(paidAmount))) {
    return { rate: roundRate(Number(paidAmount) / Number(total)), source: "derived" };
  }
  return { rate: null, source: null };
}
