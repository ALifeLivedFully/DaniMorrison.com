const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "static/js/webshop.js"), "utf8");

function loadShop(options = {}) {
  const store = options.store || {};
  const page = {
    document: {
      documentElement: { lang: "en" },
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => ({
        appendChild() { return this; },
        append() {},
        addEventListener() {},
        classList: { add() {} }
      })
    },
    location: { search: options.search || "" },
    localStorage: {
      getItem: (key) => Object.prototype.hasOwnProperty.call(store, key) ? String(store[key]) : null,
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; }
    },
    navigator: {},
    URLSearchParams,
    Intl,
    console
  };
  page.window = page;
  vm.createContext(page);
  vm.runInContext(source, page);
  return { page, store };
}

const cart = JSON.stringify([{ sku: "granola-m", quantity: 2, price: 9.95 }]);
const addons = JSON.stringify([{ group: "Gift wrapping", price: 2 }]);

test("the thank you page clears the cart after a Stripe checkout success", () => {
  const { store } = loadShop({
    search: "?stripe_session=cs_test_123",
    store: { cart, addons, ordernumber: "5329182394" }
  });

  assert.equal(store.cart, undefined);
  assert.equal(store.addons, undefined);
  assert.equal(store.ordernumber, undefined);
});

test("a thank you page without a Stripe session keeps the cart", () => {
  const { store } = loadShop({
    search: "",
    store: { cart, addons, ordernumber: "5329182394" }
  });

  assert.equal(store.cart, cart);
  assert.equal(store.addons, addons);
  assert.equal(store.ordernumber, "5329182394");
});

test("unrelated query parameters do not clear the cart", () => {
  const { store } = loadShop({
    search: "?order=5329182394&paid=false",
    store: { cart, ordernumber: "5329182394" }
  });

  assert.equal(store.cart, cart);
  assert.equal(store.ordernumber, "5329182394");
});
