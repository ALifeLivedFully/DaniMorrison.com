---
title: Static payment
---

The `static-payment` shortcode marks the spot where the payment page takes over. You can see it in action on the [payment page](/payment/). To show it, write:

```
{{</* static-payment */>}}
```

The payment brick renders the methods from `data/<lang>/payment.yaml`; `payment-simple.js` adds the amount owed and the order number from the cart, converts currencies and fills in bank, card or crypto details. The page around it should say "one moment please" — that is what a visitor without javascript keeps.

The marker it renders is also what routes the section to the payment brick.
