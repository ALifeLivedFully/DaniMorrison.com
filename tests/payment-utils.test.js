const test = require("node:test");
const assert = require("node:assert/strict");
const Utils = require("../static/js/payment-utils.js");

const fiat = {
  currency: "EUR",
  isCrypto: false,
  amount: "8.760402979",
  formattedAmount: "8.76"
};
const crypto = {
  currency: "BTC",
  isCrypto: true,
  amount: "0.0001",
  formattedAmount: "0.00010000"
};

test("provider currency defaults to the shop currency and can be overridden", () => {
  assert.equal(Utils.linkCurrency({}, "USD"), "USD");
  assert.equal(Utils.linkCurrency({ currency: "eur" }, "USD"), "EUR");
});

test("fiat payment URLs use the converted provider amount", () => {
  const url = Utils.buildPaymentUrl({
    template: "https://venmo.com/{username}?txn=pay&amount={amount}&note={order}",
    username: "ALifeLivedFully"
  }, fiat, "12345");
  assert.equal(url, "https://venmo.com/ALifeLivedFully?txn=pay&amount=8.76&note=Order%2012345");
});

test("cryptocurrency payment URIs use the crypto amount exactly once", () => {
  const uri = Utils.buildPaymentUrl({
    template: "bitcoin:{address}?amount={amount}",
    address: "bc1qtest"
  }, crypto, "12345");
  assert.equal(uri, "bitcoin:bc1qtest?amount=0.0001");

  const again = Utils.buildPaymentUrl({
    template: "bitcoin:{address}?amount={amount}",
    address: "bc1qtest"
  }, crypto, "12345");
  assert.equal(again, uri);
});

test("display and QR amounts come from the same conversion", () => {
  assert.equal(Utils.displayAmount(fiat), "8.76 EUR");
  assert.equal(Utils.displayAmount(crypto), "0.0001 BTC");
  assert.equal(Utils.paymentAmount(fiat), "8.76");
  assert.equal(Utils.paymentAmount(crypto), "0.0001");
});

test("bank QR payload uses the converted currency and amount", () => {
  const payload = Utils.buildEpcPayload({
    bic: "INGBNL2A",
    name: "Dani Morrison",
    iban: "NL48INGB0006762093",
    currency: "EUR",
    amount: "8.76",
    reference: "Order 12345"
  });
  assert.equal(payload, "BCD\n002\n1\nSCT\nINGBNL2A\nDani Morrison\nNL48INGB0006762093\nEUR8.76\n\n\nOrder 12345");
});

test("bank QR can omit the amount", () => {
  const payload = Utils.buildEpcPayload({
    bic: "INGBNL2A",
    name: "Dani Morrison",
    iban: "NL48INGB0006762093",
    currency: "EUR",
    amount: "8.76",
    includeAmount: false,
    reference: "Order 12345"
  });
  assert.equal(payload.split("\n")[7], "");
});
