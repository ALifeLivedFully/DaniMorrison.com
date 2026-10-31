(function() {
  "use strict";
  
  var section = document.querySelector('section.payment');
  if (!section) return;
  if (section.getAttribute('data-payment-mode') !== 'simple') return;
  
  function loadQR() {
    return new Promise(function(res) {
      if (typeof QRCode !== 'undefined') return res();
      var s = document.createElement('script');
      s.src = '/js/qrcode.min.js';
      s.onload = res;
      document.head.appendChild(s);
    });
  }
  
  function styleQR(el) {
    if (!el) return;
    el.classList.add('qr-themed');
  }
  
  var total = 0;
  try {
    var cart = JSON.parse(localStorage.getItem('cart')||'[]');
    var addons = JSON.parse(localStorage.getItem('addons')||'[]');
    total = cart.reduce(function(s,i){return s + i.quantity*parseFloat(i.price||0);},0);
    total += addons.reduce(function(s,a){return s + parseFloat(a.price||0);},0);
    var te = document.getElementById('paymenttotal');
    if(te) te.textContent = '$' + total.toFixed(2);
  } catch(e){}
  
  var params = (typeof URLSearchParams !== 'undefined') ? new URLSearchParams(window.location.search) : null;
  if (!total && params && params.get('amount')) {
    total = parseFloat(params.get('amount')) || 0;
    var te = document.getElementById('paymenttotal');
    if(te) te.textContent = '$' + total.toFixed(2);
  }
  
  var order = localStorage.getItem('ordernumber') || (params ? (params.get('order') || params.get('ordernumber') || '') : '') || '';
  var or = document.getElementById('order-ref');
  if(or) or.textContent = order || '';
  var cor = document.getElementById('claim-order');
  if(cor) cor.value = order;
  var bor = document.getElementById('bank-order-ref');
  if(bor) bor.textContent = order;
  
  var iban = (section.getAttribute('data-bank-iban')||'').replace(/\s/g,'');
  var bic = (section.getAttribute('data-bank-bic')||'');
  var bname = section.getAttribute('data-bank-name')||'';
  var rate = parseFloat(section.getAttribute('data-eur-rate')||'0.92');
  var eur = total * rate;
  var be = document.getElementById('bank-eur-amount');
  if(be) be.textContent = eur.toFixed(2);

  function formatTemplate(tpl, data) {
    if (!tpl) return '';
    return tpl
      .replace(/\{address\}/g, data.address || '')
      .replace(/\{amount\}/g, data.amount != null ? data.amount : '')
      .replace(/\{order\}/g, data.order ? encodeURIComponent('Order ' + data.order) : '')
      .replace(/\{ordernumber\}/g, data.order ? encodeURIComponent(data.order) : '')
      .replace(/\$\{username\}/g, data.username || '')
      .replace(/\{username\}/g, data.username || '');
  }
  
  function makeEPC() {
    loadQR().then(function(){
      if(typeof QRCode === 'undefined') return;
      var d = document.getElementById('epc-qr');
      if(!d || !iban) return;
      d.innerHTML = '';
      var epc = 'BCD\n002\n1\nSCT\n' + bic.replace(/\s/g,'') + '\n' + bname + '\n' + iban + '\nEUR' + eur.toFixed(2) + '\n\n\n' + (order ? 'Order number ' + order : '');
      new QRCode(d, {text: epc, width: 180, height: 180});
      styleQR(d);
    });
  }
  makeEPC();
  
  document.getElementById('usecue-payment-method').addEventListener('change', function(){
    document.querySelectorAll('.usecue-payment-panel').forEach(function(p){p.classList.remove('active');});
    var v = this.value;
    if(!v) return;
    if(v === 'bank'){
      var p = document.getElementById('panel-bank');
      if(p){p.classList.add('active'); makeEPC();}
    } else if(v === 'crypto'){
      var pc = document.getElementById('panel-crypto');
      if(pc) pc.classList.add('active');
    } else {
      var pan = document.getElementById('panel-' + v);
      if(pan){
        pan.classList.add('active');
        var a = pan.querySelector('.pay-link-external');
        var tpl = pan.getAttribute('data-template');
        var url = pan.getAttribute('data-url');
        var un = pan.getAttribute('data-username') || 'ALifeLivedFully';
        var showQr = pan.getAttribute('data-qr') !== 'false';
        if(tpl && !url){
          url = formatTemplate(tpl, {
            username: un,
            amount: total.toFixed(2),
            order: order
          });
        }
        if(a && url){ a.href = url; }
        var qdContainer = pan.querySelector('.usecue-qr-container');
        if(qdContainer){ qdContainer.style.display = showQr ? '' : 'none'; }
        if(showQr && url){
          setTimeout(function(){
            loadQR().then(function(){
              if(typeof QRCode === 'undefined') return;
              var qd = pan.querySelector('.ext-qr');
              if(qd){
                qd.innerHTML = '';
                new QRCode(qd, {text: url, width: 180, height: 180});
                styleQR(qd);
              }
            });
          },30);
        }
      }
    }
  });
  
  document.getElementById('crypto-coin-select').addEventListener('change', function(){
    var opt = this.options[this.selectedIndex];
    var addr = opt.getAttribute('data-address') || '';
    var tpl = opt.getAttribute('data-template') || '';
    var showQr = opt.getAttribute('data-qr') !== 'false';
    var coinName = opt.textContent || '';
    var disp = document.getElementById('crypto-display');
    var atxt = document.getElementById('crypto-addr-text');
    var payBtn = document.getElementById('crypto-pay-link');
    var payCoinSpan = document.getElementById('crypto-pay-coin');
    var copyUriBtn = document.getElementById('copy-crypto-uri-btn');
    var qrContainer = disp ? disp.querySelector('.usecue-qr-container') : null;

    if(!addr){ disp.style.display='none'; return; }
    disp.style.display='block';
    if(atxt) atxt.textContent = addr;

    var qrText = addr;
    if (tpl) {
      qrText = formatTemplate(tpl, {
        address: addr,
        amount: total.toFixed(2),
        order: order,
        username: 'ALifeLivedFully'
      });
    }

    if (payBtn) {
      if (qrText && qrText !== addr && qrText.indexOf(':') !== -1) {
        payBtn.href = qrText;
        if (payCoinSpan) payCoinSpan.textContent = coinName;
        payBtn.style.display = 'block';
      } else {
        payBtn.style.display = 'none';
      }
    }

    if (copyUriBtn) {
      if (qrText && qrText !== addr) {
        copyUriBtn.setAttribute('data-uri', qrText);
        copyUriBtn.style.display = 'block';
      } else {
        copyUriBtn.style.display = 'none';
      }
    }

    if (qrContainer) {
      qrContainer.style.display = showQr ? '' : 'none';
    }

    if (showQr) {
      setTimeout(function(){
        loadQR().then(function(){
          if(typeof QRCode === 'undefined') return;
          var q = document.getElementById('crypto-qr-box');
          if(q){
            q.innerHTML = '';
            new QRCode(q, {text: qrText, width: 180, height: 180});
            styleQR(q);
          }
        });
      },30);
    }
  });
  
  document.getElementById('copy-crypto-addr-btn').addEventListener('click', function(){
    var t = document.getElementById('crypto-addr-text').textContent;
    navigator.clipboard.writeText(t).then(function(){
      var o = this.textContent; this.textContent='Copied!'; var b=this; setTimeout(function(){b.textContent=o;},1200);
    }.bind(this));
  });

  var copyCryptoUriBtn = document.getElementById('copy-crypto-uri-btn');
  if (copyCryptoUriBtn) {
    copyCryptoUriBtn.addEventListener('click', function(){
      var uri = this.getAttribute('data-uri');
      if (uri) {
        navigator.clipboard.writeText(uri).then(function(){
          var o = copyCryptoUriBtn.textContent;
          copyCryptoUriBtn.textContent = 'Copied!';
          setTimeout(function(){ copyCryptoUriBtn.textContent = o; }, 1200);
        });
      }
    });
  }
  
  document.querySelectorAll('.copy-ext-link').forEach(function(btn){
    btn.addEventListener('click', function(){
      var p = document.querySelector('.usecue-payment-panel.active');
      if(!p) return;
      var a = p.querySelector('.pay-link-external');
      if(a && a.href && a.href !== '#'){
        navigator.clipboard.writeText(a.href).then(function(){
          var o = btn.textContent; btn.textContent='Copied!'; setTimeout(function(){btn.textContent=o;},1200);
        });
      }
    });
  });
  
  document.getElementById('claim-toggle').addEventListener('click', function(){
    document.getElementById('claim-form').classList.toggle('active');
  });
  
  document.getElementById('claim-form').addEventListener('submit', function(e){
    if(window.fetch){
      e.preventDefault();
      fetch(this.action, {method:'POST', body:new FormData(this), mode:'no-cors', keepalive:true}).catch(function(){});
      window.location.href = this.querySelector('input[name="_next"]').value;
    }
  });
  
  var ml = document.querySelector('.usecue-mailto-link');
  if(ml && order) ml.href = 'mailto:order@danimorrison.com?subject=' + encodeURIComponent('Payment Claim ' + order);
})();
