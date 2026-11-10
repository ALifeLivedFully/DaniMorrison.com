const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const sources = [
  "static/js/exchange-rates.js",
  "static/js/payment-utils.js",
  "static/js/payment-simple.js"
].map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"));

const config = {
  shop: "USD",
  rate_mode: "fixed",
  auto_fetch: false,
  cache_rates: false,
  supported: {
    USD: { enabled: true, fixed_rate: 1.0 },
    EUR: { enabled: true, fixed_rate: 0.8760402979 }
  },
  crypto: {},
  fallback: { use_fixed_rate: true, fail_if_no_rate: false },
  display: { show_amounts: true, decimal_places: 2 }
};

class ClassList {
  constructor(element) {
    this.element = element;
    this.tokens = new Set();
  }
  add(name) { this.tokens.add(name); this.sync(); }
  remove(name) { this.tokens.delete(name); this.sync(); }
  contains(name) { return this.tokens.has(name); }
  sync() { this.element.className = Array.from(this.tokens).join(" "); }
}

class Element {
  constructor(attributes = {}) {
    this.attributes = attributes;
    this.className = "";
    this.classList = new ClassList(this);
    this.style = {};
    this.textContent = "";
    this.value = "";
    this.listeners = {};
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? String(this.attributes[name])
      : null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }
}

function createPage(options = {}) {
  const section = new Element({
    "data-payment-mode": "simple",
    "data-shop-currency": "USD",
    "data-currency": "USD",
    "data-currency-position": "prefix",
    "data-currency-space": "false",
    "data-bank-iban": "NL48INGB0006762093",
    "data-bank-bic": "INGBNL2A",
    "data-bank-name": "Test",
    "data-bank-currency": "EUR",
    "data-bank-show-amounts": "true",
    "data-bank-include-amount": "true",
    "data-bank-reference": "Order {ordernumber}",
    "data-order-email": "test@example.com",
    "data-shop-id": "danimorrison"
  });
  if (options.orderEndpoint) {
    section.setAttribute("data-order-endpoint", options.orderEndpoint);
  }
  const select = new Element();
  const bankPanel = new Element();
  bankPanel.classList.add("static-payment-panel");
  bankPanel.id = "panel-bank";
  const payLink = new Element({ href: options.payLinkHref || "#" });
  const claimSection = new Element({ "data-claim-mode": options.claimMode || "mailto" });
  const claimAction = new Element();
  const claimForm = new Element();
  const claimOrder = new Element();
  const claimEmail = new Element();
  const claimMethod = new Element();
  const claimMessage = new Element();
  const claimNext = new Element();
  claimNext.value = "https://example.com/thankyou/";
  claimForm.action = "https://worker.example/claim";
  claimForm.querySelector = (selector) => {
    const match = /input\[name="([^"]+)"\]/.exec(selector);
    if (!match) return null;
    if (match[1] === "_next") return claimNext;
    return null;
  };
  const elements = {
    "paymenttotal": new Element(),
    "payment-status": new Element(),
    "static-payment-method": select,
    "panel-bank": bankPanel,
    "bank-converted-amount": new Element(),
    "bank-amount": new Element(),
    "bank-amount-row": new Element(),
    "bank-currency-label": new Element(),
    "bank-reference": new Element(),
    "epc-qr": new Element(),
    "payment-config": new Element(),
    "exchange-prefetched": new Element(),
    "claim-action": claimAction,
    "claim-form": claimForm,
    "claim-order": claimOrder,
    "claim-email": claimEmail,
    "claim-payment-method": claimMethod,
    "claim-message": claimMessage
  };
  elements["payment-config"].textContent = JSON.stringify(config);
  elements["exchange-prefetched"].textContent = "{}";

  const store = options.store || {};
  const document = {
    documentElement: { lang: "en" },
    head: { appendChild() {} },
    getElementById: (id) => elements[id] || null,
    querySelector: (selector) => {
      if (selector === "section.payment") return section;
      if (selector === ".static-payment-claim-section") return claimSection;
      if (selector === ".static-payment-panel.active") {
        return bankPanel.classList.contains("active") ? bankPanel : null;
      }
      return null;
    },
    querySelectorAll: (selector) => {
      if (selector === ".static-payment-panel") return [bankPanel];
      if (selector === ".pay-link-external") return [payLink];
      return [];
    },
    createElement: () => new Element()
  };
  const page = {
    document,
    location: { search: "" },
    localStorage: {
      getItem: (key) => Object.prototype.hasOwnProperty.call(store, key) ? String(store[key]) : null,
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; }
    },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: options.fetch || (async () => { throw new Error("offline"); }),
    prompt: options.prompt,
    FormData: options.FormData,
    URLSearchParams,
    Intl,
    setTimeout,
    clearTimeout,
    console
  };
  page.window = page;
  vm.createContext(page);
  sources.forEach((source) => vm.runInContext(source, page));
  return { page, select, bankPanel, payLink, claimSection, claimAction, claimForm, claimOrder, claimEmail, claimMethod, claimMessage, store };
}

test("selecting a payment method activates its panel in the browser", async () => {
  const { page, select, bankPanel } = createPage();
  const change = select.listeners.change[0];

  select.value = "bank";
  change.call(select);
  assert.equal(bankPanel.classList.contains("active"), true);

  await new Promise((resolve) => setTimeout(resolve, 20));

  select.value = "";
  change.call(select);
  assert.equal(bankPanel.classList.contains("active"), false);

  assert.equal(page.document.getElementById("payment-status").textContent, "");
});

test("the paid button is pre-addressed as a mailto fallback with order details", async () => {
  const { select, claimAction, claimOrder, claimEmail, claimMethod, claimMessage } = createPage({
    claimMode: "mailto",
    store: { ordernumber: "12345", email: "buyer@example.com" }
  });
  select.options = [{ textContent: "Bank Transfer (SEPA/EPC)", value: "bank" }];
  select.selectedIndex = 0;
  select.value = "bank";
  select.listeners.change.forEach((handler) => handler.call(select));

  const href = decodeURIComponent(claimAction.href);
  assert.match(href, /^mailto:test@example\.com\?/);
  assert.match(href, /subject=Payment Claim 12345/);
  assert.match(href, /Order number: 12345/);
  assert.match(href, /Payment method: Bank Transfer \(SEPA\/EPC\)/);
  assert.doesNotMatch(href, /Email: buyer@example\.com/);
  assert.equal(claimOrder.value, "12345");
  assert.equal(claimEmail.value, "buyer@example.com");
  assert.equal(claimMethod.value, "Bank Transfer (SEPA/EPC)");
  assert.match(claimMessage.value, /Order number: 12345/);
});

test("the paid button submits the hidden claim form when a worker is connected", async () => {
  const posted = [];
  class FakeFormData {
    constructor(form) { this.form = form; }
  }
  const { page, select, claimForm, claimOrder, claimEmail, claimMethod, claimMessage } = createPage({
    claimMode: "worker",
    store: { ordernumber: "12345", email: "buyer@example.com" },
    FormData: FakeFormData,
    fetch: async (url, options) => {
      posted.push({ url, options });
      return {};
    }
  });
  select.options = [{ textContent: "Bank Transfer (SEPA/EPC)", value: "bank" }];
  select.selectedIndex = 0;
  select.value = "bank";
  select.listeners.change.forEach((handler) => handler.call(select));

  let prevented = false;
  claimForm.listeners.submit[0]({ preventDefault: () => { prevented = true; } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(prevented, true);
  assert.equal(claimOrder.value, "12345");
  assert.equal(claimEmail.value, "buyer@example.com");
  assert.equal(claimMethod.value, "Bank Transfer (SEPA/EPC)");
  assert.match(claimMessage.value, /Payment method: Bank Transfer \(SEPA\/EPC\)/);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "https://worker.example/claim");
  assert.equal(posted[0].options.method, "POST");
  assert.equal(posted[0].options.mode, "no-cors");
  assert.equal(posted[0].options.keepalive, true);
  assert.ok(posted[0].options.body instanceof FakeFormData);
  assert.equal(page.location.href, "https://example.com/thankyou/");
});

test("clicking a pay link reports the payment intent", async () => {
  const posted = [];
  const { payLink, select } = createPage({
    claimMode: "mailto",
    orderEndpoint: "https://worker.example/",
    payLinkHref: "https://paypal.me/dani/25",
    store: { ordernumber: "12345" },
    fetch: async (url, options) => {
      posted.push({ url, options });
      return {};
    }
  });
  const option = new Element({ "data-currency": "EUR" });
  option.textContent = "PayPal";
  option.value = "paypal";
  select.options = [option];
  select.selectedIndex = 0;
  select.value = "paypal";

  payLink.listeners.click.forEach((handler) => handler.call(payLink));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "https://worker.example/payment-intent");
  assert.equal(posted[0].options.method, "POST");
  assert.equal(posted[0].options.keepalive, true);
  assert.deepEqual(JSON.parse(posted[0].options.body), {
    shop_id: "danimorrison",
    ordernumber: "12345",
    payment_method: "paypal",
    method_label: "PayPal",
    source: "link",
    currency: "EUR"
  });
});

test("ignores pay link clicks while the link is still a placeholder", async () => {
  const posted = [];
  const { payLink } = createPage({
    claimMode: "mailto",
    orderEndpoint: "https://worker.example/",
    store: { ordernumber: "12345" },
    fetch: async (url, options) => {
      posted.push({ url, options });
      return {};
    }
  });
  payLink.listeners.click.forEach((handler) => handler.call(payLink));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(posted.length, 0);
});

test("selecting a payment method reports the intent", async () => {
  const posted = [];
  const { select, bankPanel } = createPage({
    claimMode: "mailto",
    orderEndpoint: "https://worker.example/",
    store: { ordernumber: "12345" },
    fetch: async (url, options) => {
      posted.push({ url, options });
      return {};
    }
  });
  select.options = [{ textContent: "Bank Transfer (SEPA/EPC)", value: "bank" }];
  select.selectedIndex = 0;
  select.value = "bank";
  select.listeners.change.forEach((handler) => handler.call(select));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(bankPanel.classList.contains("active"));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "https://worker.example/payment-intent");
  const payload = JSON.parse(posted[0].options.body);
  assert.equal(payload.source, "select");
  assert.equal(payload.payment_method, "bank");
  assert.equal(payload.method_label, "Bank Transfer (SEPA/EPC)");
  assert.equal(payload.currency, "EUR");
});

test("skips the intent when no order endpoint is configured", async () => {
  const posted = [];
  const { select } = createPage({
    claimMode: "mailto",
    store: { ordernumber: "12345" },
    fetch: async (url, options) => {
      posted.push({ url, options });
      return {};
    }
  });
  select.options = [{ textContent: "Bank Transfer (SEPA/EPC)", value: "bank" }];
  select.selectedIndex = 0;
  select.value = "bank";
  select.listeners.change.forEach((handler) => handler.call(select));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posted.length, 0);
});
