Critical items to confirm before implementation:
1. Form handler: Current webshop.yaml has form_handler: http://localhost:8787/ (worker). Do you want simple mode to use this worker as PHP/form handler, or switch to Formspree and change form_handler? Also need exact Formspree fields/endpoint.
for now use cloudflare worker.

2. EUR rate: Confirm rate source (manual in payment.yaml is fine). Any auto-fetch needed or always manual?
yes to auto-fetch flag. also have flag for fetching updated manual rate on site update.

3. Payment link placeholders: Exact placeholder names per provider? For crypto, how to format addresses/links (some want bitcoin:..., others just addresses + QR).
i use username:ALifeLivedFully almost everywhere. crypto use each ones expected format and copy address button. use my ens to get addresses to initialize manual config. 

4. Catalog multilang: Generate separate /[lang]/shop/index.json or single? Products may be per-language.
seperate

5. Worker auth model: How does worker identify shop (origin header, shop_id, or config URL)? For D1 allowlist, what key to match?
shopid sent in submissions.  

6. Stripe: Test keys now or will provide? Webhook URL/secret handling?
placeholder keys

7. Legal checks details: What exactly counts as terms/address/age checks (checkboxes, validation rules)?
just a placeholder functions for legality,validation,etc returns a bool and message maybe?

8. Claim endpoint: Same as order endpoint or different URL in config?
same worker dif config line.

9. Secrets storage: For D1, how to encrypt Stripe keys (Cloudflare has secrets/KV)? Need to plan binding.
ill take your recomendation but people who pay to use my shop worker need to submit their sripe key for me to initialize checkout for them. 

---

1. Worker form flow: The current worker at http://localhost:8787/ just stores orders in D1 and redirects to /payment/ if local. For simple mode using the worker as form handler, do you want it to still do the same D1 insert (so orders go to the same orders DB) or just pass through to the payment flow? Also should the worker handle both simple and advanced modes?
use current worker as simple worker, make a new worker for advanced using wrangler command not npx since this is nixos.

2. shop_id in submissions: You said "shopid sent in submissions". Where should it come from - hidden field in checkout form populated from config, or derived from origin? Also what format?
hidden field in checkout form populated from config

3. Formspree/PHP compatibility: You want Formspree-compatible/PHP-compatible. The worker needs to accept form data like Formspree does? Or should simple mode post directly to Formspree endpoint configured in payment.yaml and not use the worker for form submission?

4. ENS/crypto addresses: You want to use username:ALifeLivedFully mostly and get crypto addresses from ENS. Should I look up addresses via ENS resolution at build time in Hugo, or at runtime in browser/worker?
flag to populate config lines at build time, flag to fallback to config addresses, flag to use ens at runtime

5. Multi-shop D1: For the D1 allowlist, should there be a separate shops table (I need to add it) and does the existing orders table need shop_id added?
if 1 D1 can cover both shops and orders then do that and attatch shopid to each order submission and each order record.

---

"IBAN NL48 INGB 0006 7620 93

1. Open your banking app
2. Choose 'Pay'
3. Copy/paste the IBAN above
4. Amount: € 19.30
5. Recipient: Hugobricks
6. Description: Order number 5317867329"

