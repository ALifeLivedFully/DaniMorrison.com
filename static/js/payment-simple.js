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
      setConverted(document.getElementById('bank-converted-amount'), conversion, bankShowAmounts);
      var amount = document.getElementById('bank-amount');
      if (amount) amount.textContent = bankShowAmounts ? conversion.formattedAmount : '';
      var amountRow = document.getElementById('bank-amount-row');
      if (amountRow) amountRow.style.display = bankShowAmounts ? '' : 'none';
      var currencyLabel = document.getElementById('bank-currency-label');
      if (currencyLabel) currencyLabel.textContent = conversion.currency;
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
      var qrContainer = panel.querySelector('.usecue-qr-container');
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
      var qrContainer = panel.querySelector('.usecue-qr-container');
      if (qrContainer) qrContainer.style.display = 'none';
    }
  }

  var cryptoRequestId = 0;

  async function renderCrypto(select, requestId) {
    var option = select && select.options[select.selectedIndex];
    var display = document.getElementById('crypto-display');
    var addressText = document.getElementById('crypto-addr-text');
    var payButton = document.getElementById('crypto-pay-link');
    var payCoin = document.getElementById('crypto-pay-coin');
    var copyUri = document.getElementById('copy-crypto-uri-btn');
    var qrBox = document.getElementById('crypto-qr-box');
    var converted = document.getElementById('crypto-converted-amount');
    var qrContainer = display ? display.querySelector('.usecue-qr-container') : null;

    if (!option) return;
    var address = option.getAttribute('data-address') || '';
    var template = option.getAttribute('data-template') || '';
    var currency = (option.getAttribute('data-currency') || option.value || '').toUpperCase();
    var showQr = option.getAttribute('data-qr') !== 'false';
    var coinName = option.textContent || currency;

    if (!address) {
      if (display) display.style.display = 'none';
      setConverted(converted, null, false);
      return;
    }
    if (display) display.style.display = 'block';
    if (addressText) addressText.textContent = address;
    if (payButton) payButton.style.display = 'none';
    if (copyUri) copyUri.style.display = 'none';

    try {
      var conversion = await conversionFor(currency);
      if (requestId !== cryptoRequestId) return;
      setConverted(converted, conversion, currencyConfig.display ? currencyConfig.display.show_amounts !== false : true);
      var uri = PU.buildPaymentUrl({ template: template, address: address }, conversion, order);
      if (payButton) {
        if (uri && uri.indexOf(':') !== -1) {
          payButton.href = uri;
          if (payCoin) payCoin.textContent = coinName;
          payButton.style.display = 'block';
        } else {
          payButton.style.display = 'none';
        }
      }
      if (copyUri) {
        if (uri) {
          copyUri.setAttribute('data-uri', uri);
          copyUri.style.display = 'block';
        } else {
          copyUri.style.display = 'none';
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
      setConverted(converted, null, false);
    }
  }

  var activeRequest = 0;
  var methodSelect = document.getElementById('usecue-payment-method');
  if (methodSelect) {
    methodSelect.addEventListener('change', function() {
      activeRequest += 1;
      cryptoRequestId += 1;
      var requestId = activeRequest;
      document.querySelectorAll('.usecue-payment-panel').forEach(function(panel) {
        panel.classList.remove('active');
      });
      setStatus('', '');
      var value = this.value;
      if (!value) return;
      if (value === 'bank') {
        var bankPanel = document.getElementById('panel-bank');
        if (bankPanel) bankPanel.classList.add('active');
        renderBank(requestId);
      } else if (value === 'crypto') {
        var cryptoPanel = document.getElementById('panel-crypto');
        if (cryptoPanel) cryptoPanel.classList.add('active');
        var coinSelect = document.getElementById('crypto-coin-select');
        if (coinSelect && coinSelect.value) renderCrypto(coinSelect, ++cryptoRequestId);
      } else {
        var panel = document.getElementById('panel-' + value);
        if (panel) {
          panel.classList.add('active');
          renderLink(panel, requestId);
        }
      }
    });
  }

  var cryptoSelect = document.getElementById('crypto-coin-select');
  if (cryptoSelect) {
    cryptoSelect.addEventListener('change', function() {
      renderCrypto(this, ++cryptoRequestId);
    });
  }

  var copyAddress = document.getElementById('copy-crypto-addr-btn');
  if (copyAddress) {
    copyAddress.addEventListener('click', function() {
      var address = document.getElementById('crypto-addr-text');
      if (!address) return;
      navigator.clipboard.writeText(address.textContent).then(function() {
        var original = copyAddress.textContent;
        copyAddress.textContent = 'Copied!';
        setTimeout(function() { copyAddress.textContent = original; }, 1200);
      });
    });
  }

  var copyCryptoUriBtn = document.getElementById('copy-crypto-uri-btn');
  if (copyCryptoUriBtn) {
    copyCryptoUriBtn.addEventListener('click', function() {
      var uri = this.getAttribute('data-uri');
      if (!uri) return;
      navigator.clipboard.writeText(uri).then(function() {
        var original = copyCryptoUriBtn.textContent;
        copyCryptoUriBtn.textContent = 'Copied!';
        setTimeout(function() { copyCryptoUriBtn.textContent = original; }, 1200);
      });
    });
  }

  document.querySelectorAll('.copy-ext-link').forEach(function(button) {
    button.addEventListener('click', function() {
      var panel = document.querySelector('.usecue-payment-panel.active');
      if (!panel) return;
      var link = panel.querySelector('.pay-link-external');
      if (link && link.href && link.href !== '#') {
        navigator.clipboard.writeText(link.href).then(function() {
          var original = button.textContent;
          button.textContent = 'Copied!';
          setTimeout(function() { button.textContent = original; }, 1200);
        });
      }
    });
  });

  var claimToggle = document.getElementById('claim-toggle');
  if (claimToggle) {
    claimToggle.addEventListener('click', function() {
      var form = document.getElementById('claim-form');
      if (form) form.classList.toggle('active');
    });
  }

  var claimForm = document.getElementById('claim-form');
  if (claimForm) {
    claimForm.addEventListener('submit', function(event) {
      if (window.fetch) {
        event.preventDefault();
        fetch(this.action, { method: 'POST', body: new FormData(this), mode: 'no-cors', keepalive: true }).catch(function() {});
        window.location.href = this.querySelector('input[name="_next"]').value;
      }
    });
  }

  var mailto = document.querySelector('.usecue-mailto-link');
  var orderEmail = (section.getAttribute('data-order-email') || '').trim();
  if (mailto && order && orderEmail) {
    mailto.href = 'mailto:' + orderEmail + '?subject=' + encodeURIComponent('Payment Claim ' + order);
  }

  if (!resolver) setStatus('Currency conversion is unavailable on this page.', 'error');
})();
