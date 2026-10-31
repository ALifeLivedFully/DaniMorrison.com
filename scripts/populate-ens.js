const https = require('https');
const fs = require('fs');
const yaml = require('js-yaml');

const ensName = 'alifelivedfully.eth';

// Simple ENS resolution via eth.limo or ens.domains API
https.get('https://api.ensideas.com/ens/resolve/' + ensName, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const result = JSON.parse(data);
      const addresses = result.addresses || {};
      const paymentPath = '/home/dani/Projects/DaniMorrison.com-v2/data/en/payment.yaml';
      const doc = yaml.load(fs.readFileSync(paymentPath, 'utf8'));
      
      if (doc.payment_links && doc.payment_links.links) {
        doc.payment_links.links.forEach(link => {
          if (link.name === 'crypto' && link.coins) {
            if (addresses.eth) link.coins.eth.address = addresses.eth;
            if (addresses.btc) link.coins.btc.address = addresses.btc;
            // Add more as needed
          }
        });
      }
      fs.writeFileSync(paymentPath, yaml.dump(doc));
      console.log('Updated addresses');
    } catch(e) {
      console.error(e);
    }
  });
}).on('error', console.error);
