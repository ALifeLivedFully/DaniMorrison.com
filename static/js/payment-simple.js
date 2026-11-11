(function() {
  "use strict";

  var section = document.querySelector('section.payment');
  if (!section) return;
  if (section.getAttribute('data-payment-mode') !== 'simple') return;

  var statusEl = document.getElementById('payment-status');
  var totalEl = document.getElementById('paymenttotal');
  var ER = window.ExchangeRates;
  var PU = window.PaymentUtils;

  function setStatus(message, state) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.setAttribute('data-state', state || '');
  }

  function errorText(error, currency) {
    var code = error && error.code;
    if (code === 'INVALID_AMOUNT') {
      return 'The order amount is invalid. Please return to the cart and try again.';
    }
    if (code === 'CURRENCY_DISABLED' || code === 'CURRENCY_NOT_CONFIGURED') {
      return 'Payments in ' + currency + ' are not available right now. Choose another method.';
    }
    if (code === 'MISSING_RATE' || code === 'NO_RATE' || code === 'NO_RATE_URL') {
      return 'A current ' + currency + ' exchange rate is unavailable. Choose another method or try again later.';
    }
    if (code === 'HTTP_ERROR' || code === 'FETCH_FAILED' || code === 'MALFORMED_JSON' ||
        code === 'INVALID_RATE' || code === 'FETCH_UNAVAILABLE') {
      return 'Could not load the current ' + currency + ' exchange rate. Choose another method or try again later.';
    }
    return 'Could not prepare the ' + currency + ' payment. Choose another method or try again later.';
  }

  function readJson(value, fallback) {
    try { return JSON.parse(value || ''); } catch (error) { return fallback; }
  }

  var currencyConfig = readJson(document.getElementById('payment-config') && document.getElementById('payment-config').textContent, {});
  var prefetched = readJson(document.getElementById('exchange-prefetched') && document.getElementById('exchange-prefetched').textContent, {});
  var resolver = null;
  if (ER && ER.createResolver) {
    resolver = ER.createResolver(currencyConfig, { prefetched: prefetched });
  }

  var shopCurrency = (currencyConfig.shop || section.getAttribute('data-shop-currency') || 'USD').toUpperCase();
  var total = '0';
  var decimals = currencyConfig.display && currencyConfig.display.decimal_places != null
    ? currencyConfig.display.decimal_places : 2;

  if (ER && ER.addAmounts) {
    try {
      var cart = JSON.parse(localStorage.getItem('cart') || '[]');
      var addons = JSON.parse(localStorage.getItem('addons') || '[]');
      var amounts = [];
      cart.forEach(function(item) {
        var line = ER.multiplyAmount(item.price, item.quantity == null ? 1 : item.quantity);
        if (line != null) amounts.push(line);
      });
      addons.forEach(function(addon) {
        var line = ER.multiplyAmount(addon.price, 1);
        if (line != null) amounts.push(line);
      });
      total = ER.addAmounts(amounts);
    } catch (error) { total = '0'; }
  }

  var params = (typeof URLSearchParams !== 'undefined') ? new URLSearchParams(window.location.search) : null;
  if (total === '0' && params && params.get('amount') && ER && ER.parseDecimal) {
    var amountParam = ER.parseDecimal(params.get('amount'));
    if (amountParam && amountParam.sign >= 0) total = ER.canonicalDecimal(amountParam);
  }

  function formatShop(amount) {
    var text = ER && ER.formatAmount ? ER.formatAmount(amount, decimals) : Number(amount).toFixed(decimals);
    try {
      if (typeof Intl !== 'undefined' && Intl.NumberFormat) {
        return new Intl.NumberFormat(document.documentElement.lang || undefined, {
          style: 'currency',
          currency: shopCurrency,
          currencyDisplay: 'narrowSymbol',
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals
        }).format(Number(text));
      }
    } catch (error) { /* fall back to the configured symbol below */ }
    var symbol = section.getAttribute('data-currency') || shopCurrency;
    var space = section.getAttribute('data-currency-space') === 'true' ? '\u00a0' : '';
    return section.getAttribute('data-currency-position') === 'suffix'
      ? text + space + symbol
      : symbol + space + text;
  }

  if (totalEl) totalEl.textContent = formatShop(total);

  var order = localStorage.getItem('ordernumber') || (params ? (params.get('order') || params.get('ordernumber') || '') : '') || '';
  var or = document.getElementById('order-ref');
  if (or) or.textContent = order || '';

  function intentCurrency() {
    var panel = document.querySelector('.static-payment-panel.active');
    if (panel && panel.getAttribute('data-currency')) return panel.getAttribute('data-currency');
    if (panel && panel.id === 'panel-bank') return section.getAttribute('data-bank-currency') || shopCurrency;
    var method = document.getElementById('static-payment-method');
    var option = method && method.options ? method.options[method.selectedIndex] : null;
    if (option && option.getAttribute && option.getAttribute('data-currency')) return option.getAttribute('data-currency');
    return shopCurrency;
  }

  function sendIntent(source) {
    var endpoint = (section.getAttribute('data-order-endpoint') || '').replace(/\/+$/, '');
    if (!order || !/^https?:/i.test(endpoint)) return;
    var method = document.getElementById('static-payment-method');
    var value = method ? method.value : '';
    if (!value) return;
    var payload = JSON.stringify({
      shop_id: section.getAttribute('data-shop-id') || '',
      ordernumber: order,
      payment_method: value,
      method_label: selectedClaimMethod(),
      source: source,
      currency: intentCurrency()
    });
    var url = endpoint + '/payment-intent';
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url, payload)) return;
    } catch (error) { /* fall back to fetch below */ }
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: payload,
        keepalive: true
      }).catch(function() { /* tracking is best effort */ });
    } catch (error) { /* tracking is best effort */ }
  }
  var cor = document.getElementById('claim-order');
  if (cor) cor.value = order;
  if (document.getElementById('bank-order-ref')) {
    document.getElementById('bank-order-ref').textContent = order;
  }

  var iban = (section.getAttribute('data-bank-iban') || '').replace(/\s/g, '');
  var bic = section.getAttribute('data-bank-bic') || '';
  var bname = section.getAttribute('data-bank-name') || '';
  var bankCurrency = (section.getAttribute('data-bank-currency') || shopCurrency).toUpperCase();
  var bankShowAmounts = section.getAttribute('data-bank-show-amounts') !== 'false';
  var bankIncludeAmount = section.getAttribute('data-bank-include-amount') !== 'false';
  var bankReferenceTemplate = section.getAttribute('data-bank-reference') || 'Order {ordernumber}';

  function bankReference() {
    return bankReferenceTemplate
      .replace(/\{ordernumber\}/g, order || '')
      .replace(/\{order\}/g, order || '');
  }

  var conversionPromises = {};
  function conversionFor(currency) {
    var code = String(currency || shopCurrency).toUpperCase();
    if (!resolver) return Promise.reject(new Error('Exchange-rate resolver is unavailable'));
    if (!conversionPromises[code]) {
      var promise = resolver.convert(code, total, { context: 'checkout' });
      conversionPromises[code] = promise;
      promise.catch(function() {
        if (conversionPromises[code] === promise) delete conversionPromises[code];
      });
    }
    return conversionPromises[code];
  }

  var qrPromise = null;
  function loadQR() {
    if (qrPromise) return qrPromise;
    qrPromise = new Promise(function(resolve) {
      if (typeof QRCode !== 'undefined') return resolve();
      var script = document.createElement('script');
      script.src = '/js/qrcode.min.js';
      script.onload = resolve;
      script.onerror = resolve;
      document.head.appendChild(script);
    });
    return qrPromise;
  }

  function styleQR(el) {
    if (el) el.classList.add('qr-themed');
  }

  function renderQR(container, text) {
    if (!container || !text) return;
    loadQR().then(function() {
      if (typeof QRCode === 'undefined') return;
      container.innerHTML = '';
      new QRCode(container, { text: text, width: 180, height: 180 });
      styleQR(container);
    });
  }

  function setConverted(el, conversion, show) {
    if (!el) return;
    if (!show) {
      el.textContent = '';
      el.style.display = 'none';
      return;
    }
    el.textContent = PU ? PU.displayAmount(conversion) : conversion.formattedAmount + ' ' + conversion.currency;
    el.style.display = '';
  }

  async function renderBank(requestId) {
    if (requestId !== activeRequest) return;
    try {
      var conversion = await conversionFor(bankCurrency);
      if (requestId !== activeRequest) return;
      var reference = bankReference();
      var amount = document.getElementById('bank-amount');
      if (amount) amount.textContent = bankShowAmounts ? conversion.formattedAmount : '';
      var amountRow = document.getElementById('bank-amount-row');
      if (amountRow) amountRow.style.display = bankShowAmounts ? '' : 'none';
      var currencyLabel = document.getElementById('bank-currency-label');
      if (currencyLabel) currencyLabel.textContent = bankShowAmounts ? conversion.currency : '';
      var referenceEl = document.getElementById('bank-reference');
      if (referenceEl) referenceEl.textContent = reference;
      var epc = PU.buildEpcPayload({
        bic: bic,
        name: bname,
        iban: iban,
        currency: conversion.currency,
        amount: conversion.formattedAmount,
        includeAmount: bankIncludeAmount && total !== '0',
        reference: reference
      });
      renderQR(document.getElementById('epc-qr'), epc);
      setStatus('', '');
    } catch (error) {
      setStatus(errorText(error, bankCurrency), 'error');
      var qr = document.getElementById('epc-qr');
      if (qr) qr.innerHTML = '';
    }
  }

  async function renderLink(panel, requestId) {
    if (!panel || requestId !== activeRequest) return;
    var currency = (panel.getAttribute('data-currency') || shopCurrency).toUpperCase();
    var link = panel.querySelector('.pay-link-external');
    var converted = panel.querySelector('[data-converted-amount]');
    try {
      var conversion = await conversionFor(currency);
      if (requestId !== activeRequest) return;
      setConverted(converted, conversion, currencyConfig.display ? currencyConfig.display.show_amounts !== false : true);
      var url = PU.buildPaymentUrl({
        template: panel.getAttribute('data-template'),
        url: panel.getAttribute('data-url'),
        username: panel.getAttribute('data-username') || '',
        address: panel.getAttribute('data-address') || ''
      }, conversion, order);
      if (link) link.href = url || '#';
      var showQr = panel.getAttribute('data-qr') !== 'false';
      var qrContainer = panel.querySelector('.static-payment-qr-container');
      if (qrContainer) qrContainer.style.display = showQr ? '' : 'none';
      if (showQr && url) {
        setTimeout(function() {
          if (requestId === activeRequest) renderQR(panel.querySelector('.ext-qr'), url);
        }, 30);
      }
      setStatus('', '');
    } catch (error) {
      if (requestId !== activeRequest) return;
      setStatus(errorText(error, currency), 'error');
      if (link) link.href = '#';
      var qrContainer = panel.querySelector('.static-payment-qr-container');
      if (qrContainer) qrContainer.style.display = 'none';
    }
  }

  var cryptoRequestId = 0;
  var ensWalletsCache = {};

  function ensApiUrl(template, name) {
    if (PU && PU.ensApiUrl) return PU.ensApiUrl(template, name);
    return String(template || "").replace(/\{name\}/g, encodeURIComponent(name || ""));
  }

  function ensAddress(wallets, coin) {
    if (PU && PU.ensAddress) return PU.ensAddress(wallets, coin);
    if (!wallets || !coin) return "";
    var address = wallets[String(coin).toLowerCase()];
    return typeof address === "string" ? address.trim() : "";
  }

  async function resolveEnsAddress(panel, coin) {
    if (!panel || panel.getAttribute('data-ens-runtime') !== 'true') return '';
    var name = panel.getAttribute('data-ens-name') || '';
    if (!name) return '';
    var url = ensApiUrl(panel.getAttribute('data-ens-api'), name);
    if (!ensWalletsCache[url]) {
      ensWalletsCache[url] = Promise.resolve().then(function() {
        if (!window.fetch) throw new Error('fetch unavailable');
        return window.fetch(url, { headers: { Accept: 'application/json' } });
      }).then(function(response) {
        if (!response || !response.ok) throw new Error('ENS lookup failed');
        return response.json();
      }).then(function(data) {
        return data && data.wallets && typeof data.wallets === 'object' ? data.wallets : {};
      });
    }
    try {
      return ensAddress(await ensWalletsCache[url], coin);
    } catch (error) {
      return '';
    }
  }

  async function renderCrypto(option, requestId) {
    var panel = document.getElementById('panel-crypto');
    if (!option || !panel) return;
    var display = document.getElementById('crypto-display');
    var title = document.getElementById('crypto-title');
    var ensName = document.getElementById('crypto-ens');
    var addressText = document.getElementById('crypto-address');
    var amountEl = document.getElementById('crypto-amount');
    var instructionCurrency = document.getElementById('crypto-instruction-currency');
    var payButton = document.getElementById('crypto-pay-link');
    var payCoin = document.getElementById('crypto-pay-coin');
    var qrBox = document.getElementById('crypto-qr-box');
    var qrContainer = qrBox && qrBox.closest ? qrBox.closest('.static-payment-qr-container') : null;

    var address = option.getAttribute('data-address') || '';
    var template = option.getAttribute('data-template') || '';
    var coin = option.getAttribute('data-coin') || '';
    var currency = (option.getAttribute('data-currency') || coin || '').toUpperCase();
    var showQr = option.getAttribute('data-qr') !== 'false';
    var coinName = (option.textContent || currency || '').trim();

    if (!address) {
      address = await resolveEnsAddress(panel, coin);
      if (requestId !== cryptoRequestId) return;
      if (!address && panel.getAttribute('data-ens-fallback') !== 'false') {
        address = option.getAttribute('data-config-address') || '';
      }
      if (address) option.setAttribute('data-address', address);
    }
    if (!address) {
      if (display) display.style.display = 'none';
      return;
    }
    if (display) display.style.display = '';
    if (title) title.textContent = coinName || 'Cryptocurrency';
    if (ensName) ensName.textContent = panel.getAttribute('data-ens-name') || '';
    if (addressText) addressText.textContent = address;
    if (qrBox) qrBox.innerHTML = '';
    if (payButton) payButton.style.display = 'none';

    try {
      var conversion = await conversionFor(currency);
      if (requestId !== cryptoRequestId) return;
      if (amountEl) amountEl.textContent = conversion.amount;
      if (instructionCurrency) instructionCurrency.textContent = conversion.currency;

      var uri = PU.buildPaymentUrl({ template: template, address: address }, conversion, order);
      if (payButton) {
        if (uri && uri.indexOf(':') !== -1) {
          payButton.href = uri;
          if (payCoin) payCoin.textContent = coinName;
          payButton.style.display = '';
        } else {
          payButton.style.display = 'none';
        }
      }
      if (qrContainer) qrContainer.style.display = showQr ? '' : 'none';
      if (showQr && uri) {
        setTimeout(function() {
          if (requestId === cryptoRequestId) renderQR(qrBox, uri);
        }, 30);
      }
      setStatus('', '');
    } catch (error) {
      if (requestId !== cryptoRequestId) return;
      setStatus(errorText(error, currency), 'error');
      if (qrBox) qrBox.innerHTML = '';
      if (qrContainer) qrContainer.style.display = 'none';
      if (amountEl) amountEl.textContent = '';
    }
  }

  function copyText(text, button, iconOnly) {
    if (!text || !button || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function() {
      if (iconOnly) {
        button.classList.add('copied');
        setTimeout(function() { button.classList.remove('copied'); }, 1200);
        return;
      }
      var original = button.textContent;
      button.textContent = 'Copied!';
      setTimeout(function() { button.textContent = original; }, 1200);
    });
  }

  var activeRequest = 0;
  var methodSelect = document.getElementById('static-payment-method');
  if (methodSelect) {
    methodSelect.addEventListener('change', function() {
      activeRequest += 1;
      cryptoRequestId += 1;
      var requestId = activeRequest;
      document.querySelectorAll('.static-payment-panel').forEach(function(panel) {
        panel.classList.remove('active');
      });
      setStatus('', '');
      var value = this.value;
      if (!value) return;
      var option = this.options ? this.options[this.selectedIndex] : null;
      var coin = option && option.getAttribute ? option.getAttribute('data-coin') : '';
      if (value === 'bank') {
        var bankPanel = document.getElementById('panel-bank');
        if (bankPanel) bankPanel.classList.add('active');
        renderBank(requestId);
      } else if (coin) {
        var cryptoPanel = document.getElementById('panel-crypto');
        if (cryptoPanel) cryptoPanel.classList.add('active');
        renderCrypto(option, ++cryptoRequestId);
      } else {
        var panel = document.getElementById('panel-' + value);
        if (panel) {
          panel.classList.add('active');
          renderLink(panel, requestId);
        }
      }
      sendIntent('select');
    });
  }

  document.querySelectorAll('[data-copy-target]').forEach(function(button) {
    button.addEventListener('click', function() {
      var target = document.getElementById(this.getAttribute('data-copy-target'));
      if (!target) return;
      copyText(target.textContent.trim(), this, true);
    });
  });

  document.querySelectorAll('.copy-ext-link').forEach(function(button) {
    button.addEventListener('click', function() {
      var panel = document.querySelector('.static-payment-panel.active');
      if (!panel) return;
      var link = panel.querySelector('.pay-link-external');
      if (link && link.href && link.href !== '#') {
        copyText(link.href, button);
      }
    });
  });

  var stripeCheckoutBusy = false;

  function resetStripeLink(link) {
    stripeCheckoutBusy = false;
    link.classList.remove('busy');
    var label = link.getAttribute('data-original-label');
    if (label) link.textContent = label;
  }

  function startStripeCheckout(link) {
    if (stripeCheckoutBusy) return;
    var endpoint = (section.getAttribute('data-order-endpoint') || '').replace(/\/+$/, '');
    if (!order || !/^https?:/i.test(endpoint) || !window.fetch) {
      setStatus('Card checkout is not available right now. Choose another payment method.', 'error');
      return;
    }
    stripeCheckoutBusy = true;
    link.setAttribute('data-original-label', link.textContent);
    link.classList.add('busy');
    link.textContent = 'Contacting card processor...';
    fetch(endpoint + '/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shop_id: section.getAttribute('data-shop-id') || '',
        ordernumber: order
      })
    }).then(function(response) {
      return response.json().catch(function() { return null; }).then(function(body) {
        return { ok: response.ok, status: response.status, body: body };
      });
    }).then(function(outcome) {
      if (outcome.ok && outcome.body && outcome.body.url && /^https?:/i.test(outcome.body.url)) {
        window.location.href = outcome.body.url;
        return;
      }
      if (outcome.status === 409 && outcome.body && outcome.body.code === 'order_not_payable') {
        resetStripeLink(link);
        setStatus(outcome.body.orderStatus === 'paid'
          ? 'This order was already paid. Check your email for the receipt.'
          : 'This order can no longer be paid online. Please contact us.', 'error');
        return;
      }
      throw new Error('invalid session');
    }).catch(function() {
      resetStripeLink(link);
      setStatus('Could not start the card payment. Please choose another method or try again later.', 'error');
    });
  }

  document.querySelectorAll('.pay-link-external').forEach(function(link) {
    link.addEventListener('click', function(event) {
      var href = link.getAttribute('href') || '';
      if (href && href !== '#') sendIntent('link');
      var panel = link.closest ? link.closest('.static-payment-panel') : null;
      if (panel && panel.getAttribute('data-checkout') === 'stripe') {
        if (event && event.preventDefault) event.preventDefault();
        startStripeCheckout(link);
      }
    });
  });

  /* Returning with the browser's back button restores this page from the
     back/forward cache exactly as it was left: the card link mid-flight,
     marked busy with the processor message. pageshow runs on that restore,
     so the link comes back and a second attempt is possible. */
  window.addEventListener('pageshow', function(event) {
    if (!event.persisted) return;
    stripeCheckoutBusy = false;
    document.querySelectorAll('.pay-link-external').forEach(function(link) {
      var panel = link.closest ? link.closest('.static-payment-panel') : null;
      if (panel && panel.getAttribute('data-checkout') === 'stripe') {
        link.classList.remove('busy');
        var label = link.getAttribute('data-original-label');
        if (label) link.textContent = label;
      }
    });
  });

  var claimSection = document.querySelector('.static-payment-claim-section');
  var claimForm = document.getElementById('claim-form');
  var claimAction = document.getElementById('claim-action');
  var claimOrder = document.getElementById('claim-order');
  var claimEmail = document.getElementById('claim-email');
  var claimMethod = document.getElementById('claim-payment-method');
  var claimMessage = document.getElementById('claim-message');
  var claimEmailFallback = document.getElementById('claim-email-fallback');
  var orderEmail = (section.getAttribute('data-order-email') || '').trim();
  var savedEmail = '';
  try { savedEmail = (localStorage.getItem('email') || '').trim(); } catch (error) { savedEmail = ''; }

  function selectedClaimMethod() {
    var method = document.getElementById('static-payment-method');
    if (!method || !method.value) return '';
    var option = method.options ? method.options[method.selectedIndex] : null;
    var label = option ? (option.textContent || '') : '';
    return (label || method.value).trim();
  }

  function claimMessageText(method) {
    var lines = ['I have paid for this order.'];
    var details = [];
    if (order) details.push('Order number: ' + order);
    if (method) details.push('Payment method: ' + method);
    if (total && total !== '0') details.push('Amount: ' + formatShop(total));
    if (details.length) lines.push('', details.join('\n'));
    return lines.join('\n');
  }

  function claimMailto(method) {
    var subject = 'Payment Claim' + (order ? ' ' + order : '');
    var url = 'mailto:' + orderEmail + '?subject=' + encodeURIComponent(subject);
    var body = claimMessageText(method);
    if (body) url += '&body=' + encodeURIComponent(body);
    return url;
  }

  function syncClaim() {
    var method = selectedClaimMethod();
    if (claimOrder) claimOrder.value = order || '';
    if (claimEmail) claimEmail.value = savedEmail;
    if (claimMethod) claimMethod.value = method;
    if (claimMessage) claimMessage.value = claimMessageText(method);
    if (claimAction && claimSection && claimSection.getAttribute('data-claim-mode') === 'mailto' && orderEmail) {
      claimAction.href = claimMailto(method);
    }
    if (claimEmailFallback && orderEmail) claimEmailFallback.href = claimMailto(method);
  }

  syncClaim();
  if (methodSelect) methodSelect.addEventListener('change', syncClaim);

  if (claimForm) {
    claimForm.addEventListener('submit', function(event) {
      if (!window.fetch) return;
      event.preventDefault();

      var email = savedEmail;
      if (!email && typeof window.prompt === 'function') {
        email = (window.prompt('Email address used for this order:', '') || '').trim();
      }
      if (!email) {
        setStatus('Enter the email address used at checkout to complete your order.', 'error');
        return;
      }
      savedEmail = email;
      try { localStorage.setItem('email', savedEmail); } catch (error) { /* storage is optional */ }
      syncClaim();

      var nextInput = claimForm.querySelector('input[name="_next"]');
      var nextUrl = nextInput ? nextInput.value : '';
      var original = claimAction ? claimAction.textContent : '';
      if (claimAction) {
        claimAction.disabled = true;
        claimAction.textContent = 'Sending...';
      }
      var restore = function() {
        if (!claimAction) return;
        claimAction.disabled = false;
        claimAction.textContent = original;
      };

      fetch(claimForm.action, {
        method: 'POST',
        body: new FormData(claimForm),
        mode: 'no-cors',
        keepalive: true
      }).then(function() {
        try {
          localStorage.removeItem('cart');
          localStorage.removeItem('addons');
          localStorage.removeItem('ordernumber');
        } catch (error) { /* storage is optional */ }
        if (nextUrl) window.location.href = nextUrl;
        else restore();
      }).catch(function() {
        restore();
        setStatus('Could not send the payment confirmation. Please use the email link and try again.', 'error');
      });
    });
  }

  if (!resolver) setStatus('Currency conversion is unavailable on this page.', 'error');
})();
