const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "static/js/webshop.js"), "utf8");

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
    this.disabled = false;
    this.hidden = false;
    this.listeners = {};
    this.children = [];
    this.options = [];
    this.selectedIndex = 0;
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? String(this.attributes[name])
      : null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }
  appendChild(node) { this.children.push(node); return node; }
  append(...nodes) { this.children.push(...nodes); }
}

function loadPage(options = {}) {
  const store = options.store || {};
  const pageListeners = {};

  const submitButton = new Element();
  const errorBox = new Element();
  errorBox.hidden = true;
  const fields = {};
  ["email", "order", "checkout", "ordernumber", "country",
    "firstname", "lastname", "address", "zipcode", "city", "_next"]
    .forEach((name) => { fields[name] = new Element(); });
  const shippingOption = new Element({ "data-price": "15", "data-always": "" });
  shippingOption.value = "Shipping World";
  const shippingSelect = new Element();
  shippingSelect.options = [shippingOption];
  shippingSelect.value = "Shipping World";

  const calculation = new Element();
  const checkout = new Element({
    "data-payment-link": "https://example.com/payment/",
    "data-currency": "USD",
    "data-currency-position": "prefix",
    "data-currency-space": "false",
    "data-currency-code": "USD",
    "data-label-cart": "Shopping cart",
    "data-label-total": "Payment total",
    "data-label-amount": "Amount"
  });
  checkout.querySelector = (selector) => {
    const name = /name='([^']+)'/.exec(selector);
    if (name) return fields[name[1]] || null;
    if (selector === "button[type='submit']") return submitButton;
    if (selector === ".checkout-error") return errorBox;
    if (selector === "select[name='shipping']") return shippingSelect;
    return null;
  };
  checkout.querySelectorAll = (selector) => {
    if (selector === "select") return [shippingSelect];
    return [];
  };

  const document = {
    documentElement: { lang: "en" },
    querySelector: (selector) =>
      selector === "section.checkout .calculation" ? calculation : null,
    querySelectorAll: () => [],
    getElementById: (id) => (id === "checkoutform" && options.checkoutForm ? checkout : null),
    createElement: () => new Element()
  };
  const page = {
    document,
    location: { search: options.search || "", href: "" },
    localStorage: {
      getItem: (key) => Object.prototype.hasOwnProperty.call(store, key) ? String(store[key]) : null,
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; }
    },
    fetch: options.fetch ||
      (async () => ({ ok: true, text: async () => JSON.stringify({ success: true }) })),
    URLSearchParams,
    Intl,
    addEventListener: (type, handler) => {
      (pageListeners[type] = pageListeners[type] || []).push(handler);
    },
    navigator: {},
    console
  };
  page.window = page;
  vm.createContext(page);
  vm.runInContext(source, page);
  return { page, store, checkout, submitButton, pageListeners };
}

const cart = JSON.stringify([{ sku: "granola-m", quantity: 2, price: 9.95 }]);
const addons = JSON.stringify([{ group: "Gift wrapping", price: 2 }]);

test("the thank you page clears the cart after a Stripe checkout success", () => {
  const { store } = loadPage({
    search: "?stripe_session=cs_test_123",
    store: { cart, addons, ordernumber: "5329182394" }
  });

  assert.equal(store.cart, undefined);
  assert.equal(store.addons, undefined);
  assert.equal(store.ordernumber, undefined);
});

test("a thank you page without a Stripe session keeps the cart", () => {
  const { store } = loadPage({
    search: "",
    store: { cart, addons, ordernumber: "5329182394" }
  });

  assert.equal(store.cart, cart);
  assert.equal(store.addons, addons);
  assert.equal(store.ordernumber, "5329182394");
});

test("unrelated query parameters do not clear the cart", () => {
  const { store } = loadPage({
    search: "?order=5329182394&paid=false",
    store: { cart, ordernumber: "5329182394" }
  });

  assert.equal(store.cart, cart);
  assert.equal(store.ordernumber, "5329182394");
});

test("submitting the checkout moves the buyer on to the payment page", async () => {
  const { page, store, checkout, submitButton } = loadPage({
    checkoutForm: true,
    store: { cart }
  });

  checkout.listeners.submit[0]({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(submitButton.disabled, true);
  assert.equal(page.location.href, "https://example.com/payment/");
  assert.ok(store.ordernumber);
});

test("a checkout page restored from the back/forward cache re-enables its submit button", async () => {
  const { page, submitButton, checkout, pageListeners } = loadPage({
    checkoutForm: true,
    store: { cart }
  });

  checkout.listeners.submit[0]({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(submitButton.disabled, true);

  pageListeners.pageshow.forEach((handler) => handler({ persisted: false }));
  assert.equal(submitButton.disabled, true);

  pageListeners.pageshow.forEach((handler) => handler({ persisted: true }));
  assert.equal(submitButton.disabled, false);
  assert.equal(page.location.href, "https://example.com/payment/");
});
