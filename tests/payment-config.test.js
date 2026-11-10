const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const ER = require("../static/js/exchange-rates.js");

const file = path.join(__dirname, "../data/en/payment.yaml");
const payment = yaml.load(fs.readFileSync(file, "utf8"));

test("the payment config parses and passes currency validation", () => {
  assert.equal(payment.currency.shop, "USD");
  assert.equal(payment.currency.rate_mode, "automatic");
  assert.equal(payment.currency.supported.USD.fixed_rate, 1);
  assert.equal(payment.currency.supported.EUR.rate_json_path, "rates.EUR");
  assert.equal(payment.currency.crypto.BTC.decimals, 8);
  assert.ok(payment.currency.crypto.providers.coinpaprika);
  assert.ok(payment.currency.crypto.providers.kraken);

  const validation = ER.validateConfig(payment.currency);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("bank QR and bank details use the new top-level shape", () => {
  // The bank details are placeholder data kept for forks of this site, so the
  // bank transfer option stays disabled until real account data replaces it.
  assert.equal(payment.bank_qr.enabled, false);
  assert.equal(payment.bank_qr.currency, "EUR");
  assert.equal(payment.bank.iban, "NL48INGB0006762093");
  assert.equal(payment.bank.reference_template, "Order {ordernumber}");
});

test("payment links can override the shop currency", () => {
  for (const link of payment.payment_links.links) {
    assert.equal(link.currency, "USD");
  }
});

test("the card link uses the worker-backed Stripe checkout", () => {
  const card = payment.payment_links.links.find((link) => link.name === "card");
  assert.equal(card.enabled, true);
  assert.equal(card.checkout, "stripe");
  assert.equal(card.qr, false);
  assert.equal(card.currency, "USD");
});

test("normalized rates convert once for fiat and crypto", async () => {
  const resolver = ER.createResolver(payment.currency, {
    fetch: async () => { throw new Error("tests must not call live services"); }
  });
  const eur = await resolver.convert("EUR", "10", { context: "checkout" });
  assert.equal(eur.rate, "0.8760402979");
  assert.equal(eur.formattedAmount, "8.76");

  const btc = await resolver.convert("BTC", "10", { context: "checkout" });
  assert.equal(btc.rate, "0.000012");
  assert.equal(btc.formattedAmount, "0.00012000");
  assert.equal(btc.isCrypto, true);
});
