---
title: Payment
weight: 5
---

Payment details live in `data/<lang>/payment.yaml`. Prices in product front matter and in the browser cart are always kept in the shop currency; other currencies are calculated for display and payment only.

## Shop currency

```yaml
currency:
  shop: USD
```

Set `webshop.yaml` to the same code and symbol so prices, cart totals and payment totals agree:

```yaml
# data/<lang>/webshop.yaml
currency_code: USD
currency_symbol: $
```

`currency.shop` is the currency all prices are stored in. When a payment method uses another currency, the configured rate is normalised to *target units per one shop-currency unit*. For example, with shop currency USD, EUR uses about `0.87` EUR per USD, while BTC uses about `0.00001` BTC per USD.

## Rate modes

```yaml
currency:
  rate_mode: automatic
  auto_fetch: true
  fetch_on_site_update: false
  cache_rates: true
  cache_ttl: 3600
  crypto_cache_ttl: 300
```

| Key | Meaning |
| --- | --- |
| `rate_mode` | `fixed` never fetches, `fetch` requires a cached or fetched rate, `automatic` fetches and then falls back to a fixed rate. |
| `auto_fetch` | Allow exchange rates to be fetched in the browser when a payment method is selected. |
| `fetch_on_site_update` | Allow Hugo to prefetch currencies that have a direct `rate_url` during a build. Shared provider URLs are used at runtime. |
| `cache_rates` | Cache valid rates in `localStorage` (and use build-time values). |
| `cache_ttl` | Lifetime in seconds for fiat rates. |
| `crypto_cache_ttl` | Lifetime in seconds for cryptocurrency rates. Keep this short. |

A build-time fetch stores the raw API value. The browser validates it and applies `invert_rate`, exactly as it would for a live fetch. Failed build-time requests are skipped and the configured fallback still applies.

## Fiat currencies

```yaml
currency:
  supported:
    USD:
      enabled: true
      fixed_rate: 1.0
    EUR:
      enabled: true
      fixed_rate: 0.8760402979
      rate_url: "https://api.frankfurter.app/latest?from=USD&to=EUR"
      rate_json_path: "rates.EUR"
      invert_rate: false
```

| Key | Meaning |
| --- | --- |
| `enabled` | Set to `false` to hide or reject this currency. |
| `fixed_rate` | Fallback rate, and the only rate in `fixed` mode. Must be positive. |
| `rate_url` | JSON endpoint returning a rate. Required for `fetch` mode. |
| `rate_json_path` | Dot path to the value, such as `rates.EUR` or `quotes.USD.price`. |
| `invert_rate` | Set `true` when the API returns *shop currency per target unit*. The resolver takes the reciprocal once. |
| `cache_ttl` | Optional per-currency override in seconds. |
| `decimals` | Optional number of decimal places for display. |

When the site currency is not USD, build the `rate_url` for that shop currency. For example, for a EUR shop convert USD to EUR with `from=EUR&to=USD` and a rate normalised as USD per EUR.

## Cryptocurrencies

```yaml
currency:
  crypto:
    BTC:
      enabled: true
      decimals: 8
      fixed_rate: 0.000012
      rate_url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
      rate_json_path: "bitcoin.usd"
      invert_rate: true
    ETH:
      enabled: true
      decimals: 8
      fixed_rate: 0.0003
      rate_url: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
      rate_json_path: "ethereum.usd"
      invert_rate: true
```

CoinGecko returns USD per BTC, so `invert_rate: true` turns it into BTC per USD. Set `decimals` to the precision supported by the coin. Crypto amounts are rounded **up** so a customer does not underpay, and an expired crypto cache is rejected at checkout.

Crypto payment templates receive the calculated coin amount through `{amount}`:

```yaml
coins:
  btc:
    enabled: true
    address: "bc1q..."
    template: "bitcoin:{address}?amount={amount}"
  xmr:
    enabled: true
    address: "44..."
    template: "monero:{address}?tx_amount={amount}"
```

The same calculated amount is shown in the payment panel, placed in the payment URI and rendered in its QR code. If no fresh rate is available, the payment URI and QR code are not offered.

## ENS crypto addresses

A crypto link can fill wallet addresses from an ENS name instead of maintaining every coin address by hand:

```yaml
payment_links:
  links:
    - name: crypto
      enabled: true
      use_ens: true
      ens_name: "alifelivedfully.eth"
      populate_from_ens_at_build: true
      ens_fallback_to_config: true
      runtime_ens_resolution: false
      # ens_api_url: "https://api.ensdata.net/{name}"
      coins:
        eth:
          enabled: true
          address: "0x70B5901f6cFEFb514dBe1656c08fA1b875F28E96"
          template: "ethereum:{address}@1?value={amount}"
```

| Key | Meaning |
| --- | --- |
| `use_ens` | Resolve wallet addresses from ENS for this crypto link. |
| `ens_name` | ENS name to resolve, such as `alifelivedfully.eth`. |
| `ens_api_url` | Optional lookup URL template, default `https://api.ensdata.net/{name}`. The response must contain a `wallets` object keyed by coin code. |
| `populate_from_ens_at_build` | Fetch the ENS record during the Hugo build. A resolved address overrides the matching `coins.*.address`. |
| `ens_fallback_to_config` | Use `coins.*.address` when the ENS response omits that coin or the lookup fails. With `false`, the coin is hidden unless an ENS address is available. |
| `runtime_ens_resolution` | Let the browser fetch the ENS record when a coin has no build-time address. Build-time values still take priority. |

Coin codes are matched case-insensitively against the ENS response, so `eth`, `btc`, `dash`, `ltc` and `xmr` use the corresponding `wallets` entries. Keep valid configured addresses even when ENS is enabled: they are the offline fallback. Build-time lookup failures are logged and the build continues with configured addresses when fallback is enabled.

## Alternative providers

CoinPaprika and Kraken can be configured as shared providers. A coin uses its own `rate_url` first; these settings are there for coins without one or for installations that prefer another provider.

```yaml
currency:
  crypto:
    providers:
      coinpaprika:
        enabled: true
        url_template: "https://api.coinpaprika.com/v1/tickers/{coin_id}"
        rate_json_path: "quotes.USD.price"
        invert_rate: true
        coin_ids:
          BTC: btc-bitcoin
          ETH: eth-ethereum
          LTC: ltc-litecoin
          XMR: xmr-monero
          DASH: dash-dash
      kraken:
        enabled: true
        url_template: "https://api.kraken.com/0/public/Ticker?pair={pair}"
        rate_json_path: "result.{result}.c.0"
        invert_rate: true
        pair_map:
          BTC: XBTUSD
          ETH: ETHUSD
          LTC: LTCUSD
          XMR: XMRUSD
          DASH: DASHUSD
        result_map:
          BTC: XXBTZUSD
          ETH: XETHZUSD
          LTC: XLTCZUSD
          XMR: XXMRZUSD
          DASH: DASHUSD
```

Fiat providers can be shared under `currency.providers`:

```yaml
currency:
  providers:
    frankfurter:
      enabled: true
      url_template: "https://api.frankfurter.app/latest?from={shop}&to={currency}"
      rate_json_path: "rates.{currency}"
      invert_rate: false
```

Provider placeholders are `{currency}`, `{shop}`, `{coin_id}`, `{pair}` and `{result}`. `coin_ids` (or `ids`) map a coin code to a provider ID; `pair_map` and `result_map` can map a query pair and a different response key. A direct `rate_url` on a currency always takes priority over shared providers.

Provider URLs are public configuration and end up in the page. Never put an API secret in a `rate_url`.

## Fallback behaviour

```yaml
currency:
  fallback:
    use_fixed_rate: true
    fail_if_no_rate: false
```

In `automatic` mode, a failed fetch uses `fixed_rate` only when `use_fixed_rate` is true and `fail_if_no_rate` is false. In `fetch` mode there is no silent fallback. A missing or invalid rate is an error; the shop never substitutes a 1:1 rate for an unknown currency.

The shop currency itself always resolves as 1:1.

## Display

```yaml
currency:
  display:
    show_amounts: true
    decimal_places: 2
```

`decimal_places` controls the shop total and fiat conversion display. `show_amounts: false` hides the extra converted amount line in payment panels, but the correct amount is still used in the payment link or bank QR code.

## Payment link currencies

Each link defaults to `currency.shop`. Add `currency` when that provider expects another currency:

```yaml
payment_links:
  links:
    - name: revolut
      enabled: true
      template: "https://revolut.me/{username}/{amount}"
      currency: EUR
      qr: true
      username: "ALifeLivedFully"
```

The amount is converted once, then used for both the displayed amount and the generated URL or QR code. Supported placeholders are `{username}`, `{amount}`, `{order}`, `{ordernumber}` and `{address}`.

## Labels and selector order

The payment selector shows two groups: **Traditional Payments** and **Cryptocurrency**. The bank transfer is listed first, then each enabled non-crypto link in the order it appears under `payment_links.links`. Use `label` to control the visible name:

```yaml
bank:
  label: "European Bank Transfer"

payment_links:
  links:
    - name: paypal
      enabled: true
      label: "PayPal"
      template: "https://paypal.me/{username}/{amount}"
```

Cryptocurrency coins are individual options in the same selector. Set `coin_order` on the crypto link to choose their order; labels come from each coin's `label`:

```yaml
    - name: crypto
      enabled: true
      coin_order: [xmr, eth, btc, dash, ltc]
      coins:
        xmr:
          enabled: true
          label: "Monero (XMR)"
          address: "44..."
          template: "monero:{address}?tx_amount={amount}"
```

Without `coin_order`, coins are listed in alphabetical order by their key.

## Bank transfer and QR

Bank details and the bank QR code are top-level sections:

```yaml
bank_qr:
  enabled: true
  currency: EUR
  show_amounts: true
  include_amount_in_qr: true

bank:
  iban: "NL48INGB0006762093"
  bic: "INGBNL2A"
  name: "Dani Morrison"
  reference_template: "Order {ordernumber}"
```

`bank_qr.currency` defaults to `currency.shop` when omitted. The amount is resolved through the same rate table as other methods and the EPC QR payload uses the resulting amount and currency. Set `include_amount_in_qr: false` for a transfer where the payer enters the amount.

Older files may have `currency.bank_qr`. It is still read as a fallback for the `bank_qr` settings, but new configurations should use the top-level section above.

## Validation and tests

The exchange-rate module refuses non-positive rates, malformed JSON, missing JSON paths, invalid amounts, disabled currencies and expired crypto cache entries. Add a `fixed_rate` for every currency you want to keep working offline.

The repository tests use mocked API responses and never call a live service:

```sh
npm test
```
