const required = [
  "ordernumber", "firstname", "lastname", "email",
  "address", "zipcode", "city", "shipping", "country",
  "gift-wrapping", "custom-engraving", "order", "checkout"
];

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
        await env.orders.prepare(`
          INSERT INTO claims (shop_id, ordernumber, email, claim_data)
          VALUES (?, ?, ?, ?)
        `).bind(shopId, claimData.ordernumber, claimData.email, JSON.stringify(claimData)).run();
      } catch (error) {
        console.error("D1 claim insert failed:", error);
        return new Response("Could not save claim", { status: 500 });
      }
      
      const next = new URL(String(form.get("_next") || "/"), request.url);
      if (next.origin === request.url && next.pathname.includes("thank")) {
        return Response.redirect(next.href, 303);
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

    try {
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
        data._next
      ).run();
    } catch (error) {
      console.error("D1 insert failed:", error);
      return new Response("Could not save order", { status: 500 });
    }

    const next = new URL(data._next || "/", request.url);
    if (
      next.origin === "http://localhost:1313" &&
      next.pathname === "/payment/"
    ) {
      return Response.redirect(next.href, 303);
    }

    return new Response("Order saved successfully", { status: 201 });
  }
};
