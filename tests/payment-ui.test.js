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

function createPage() {
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
    "data-order-email": "test@example.com"
  });
  const select = new Element();
  const bankPanel = new Element();
  bankPanel.classList.add("usecue-payment-panel");
  const elements = {
    "paymenttotal": new Element(),
    "payment-status": new Element(),
    "usecue-payment-method": select,
    "panel-bank": bankPanel,
    "bank-converted-amount": new Element(),
    "bank-amount": new Element(),
    "bank-amount-row": new Element(),
    "bank-currency-label": new Element(),
    "bank-reference": new Element(),
    "epc-qr": new Element(),
    "payment-config": new Element(),
    "exchange-prefetched": new Element()
  };
  elements["payment-config"].textContent = JSON.stringify(config);
  elements["exchange-prefetched"].textContent = "{}";

  const document = {
    documentElement: { lang: "en" },
    head: { appendChild() {} },
    getElementById: (id) => elements[id] || null,
    querySelector: (selector) => selector === "section.payment" ? section : null,
    querySelectorAll: (selector) => selector === ".usecue-payment-panel" ? [bankPanel] : [],
    createElement: () => new Element()
  };
  const page = {
    document,
    location: { search: "" },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async () => { throw new Error("offline"); },
    URLSearchParams,
    Intl,
    setTimeout,
    clearTimeout,
    console
  };
  page.window = page;
  vm.createContext(page);
  sources.forEach((source) => vm.runInContext(source, page));
  return { page, select, bankPanel };
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
