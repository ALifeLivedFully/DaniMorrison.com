const required = [
  "ordernumber", "firstname", "lastname", "email",
  "address", "zipcode", "city", "shipping", "country",
  "gift-wrapping", "custom-engraving", "order", "checkout"
];

/* The origin of the page that submitted the form, when there is one. Browsers
   send `Origin` on every cross-origin post (a `null` value from file:// pages
   included), so this is where redirects should resolve `_next`. */
function submittingOrigin(request) {
  const header = request.headers.get("Origin");
  if (!header || header === "null") return null;
  try {
    return new URL(header).origin;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST" }
      });
    }

    const contentType = request.headers.get("Content-Type") || "";
    if (
      !contentType.includes("application/x-www-form-urlencoded") &&
      !contentType.includes("multipart/form-data")
    ) {
      return new Response("Unsupported content type", { status: 415 });
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return new Response("Invalid form data", { status: 400 });
    }

    if (form.get("_gotcha")) {
      return new Response("Submission received");
    }

    const type = form.get("form_type") || "order";
    const shopId = String(form.get("shop_id") || "").trim();
    
    if (type === "claim") {
      const claimData = {
        ordernumber: String(form.get("ordernumber") || "").trim(),
        email: String(form.get("email") || "").trim(),
        message: String(form.get("message") || "").trim(),
        payment_method: String(form.get("payment_method") || "").trim()
      };
      
      if (!claimData.ordernumber || !claimData.email) {
        return new Response("Missing required fields", { status: 400 });
      }
      
      try {
        const orderResult = await env.orders.prepare(`
          SELECT id FROM orders WHERE ordernumber = ? AND (shop_id = ? OR shop_id = '') ORDER BY id DESC LIMIT 1
        `).bind(claimData.ordernumber, shopId).first();
        
        await env.orders.prepare(`
          INSERT INTO claims (shop_id, order_id, ordernumber, email, claim_data)
          VALUES (?, ?, ?, ?, ?)
        `).bind(shopId, orderResult?.id || null, claimData.ordernumber, claimData.email, JSON.stringify(claimData)).run();
        
        if (orderResult?.id) {
          await env.orders.prepare(`
            UPDATE orders SET status = ?, payment_method = ?, claim_info = ? WHERE id = ?
          `).bind(
            'claimed',
            claimData.payment_method || null,
            JSON.stringify(claimData),
            orderResult.id
          ).run();
        }
      } catch (error) {
        console.error("D1 claim insert failed:", error);
        return new Response("Could not save claim", { status: 500 });
      }
      
      /* `_next` travels root-relative (baked from the data file, not against a
         base URL) and is resolved against the page that submitted the form,
         via its `Origin` header — so the same form works from localhost and
         production alike, and the handler's redirect never carries a visitor
         across domains. Posts from outside a site browser (no Origin header,
         curl) take the plain response instead. */
      const browserOrigin = submittingOrigin(request);
      if (browserOrigin) {
        const next = new URL(String(form.get("_next") || "/"), browserOrigin);
        if (next.pathname.includes("thank")) {
          return Response.redirect(next.href, 303);
        }
      }
      return new Response("Claim submitted successfully", { status: 201 });
    }

    const data = Object.fromEntries(
      [...required, "message", "_next", "shop_id"].map(name => [
        name,
        String(form.get(name) ?? "").trim()
      ])
    );

    if (required.some(name => !data[name])) {
      return new Response("Missing required fields", { status: 400 });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      return new Response("Invalid email address", { status: 400 });
    }

    /* `_next` travels root-relative (`/_next` is taken from the data file, not
       baked against a base URL) and is resolved against the page that
       submitted the form, via its `Origin` header — so the same form works
       from localhost and production alike, and the handler's redirect never
       carries a visitor across domains. Posts from outside a site browser (no
       Origin header, curl) resolve against the handler's own URL. */
    const browserOrigin = submittingOrigin(request);
    const next = new URL(data._next || "/", browserOrigin || request.url);

    try {
      /* Store the resolved, absolute URL the visitor will be walked to, so the
         order record says which page delivered it, whichever origin that was. */
      await env.orders.prepare(`
        INSERT INTO orders (
          shop_id, ordernumber, firstname, lastname, email, address,
          zipcode, city, shipping, country, gift_wrapping,
          custom_engraving, message, order_details, checkout, next_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        shopId,
        data.ordernumber,
        data.firstname,
        data.lastname,
        data.email,
        data.address,
        data.zipcode,
        data.city,
        data.shipping,
        data.country,
        data["gift-wrapping"],
        data["custom-engraving"],
        data.message,
        data.order,
        data.checkout,
        next.href
      ).run();
    } catch (error) {
      console.error("D1 insert failed:", error);
      return new Response("Could not save order", { status: 500 });
    }

    /* The no-javascript walk to the payment page: the origin comes from the
       submitting page (above), the path from the data file, so the visitor is
       redirected within their own site, never to the handler's domain or a
       baked, unrelated one. */
    if (browserOrigin && next.pathname === "/payment/") {
      return Response.redirect(next.href, 303);
    }

    return new Response("Order saved successfully", { status: 201 });
  }
};
