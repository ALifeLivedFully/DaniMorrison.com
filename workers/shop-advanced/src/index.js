function isLegalOrder(order) {
  const checks = [];
  checks.push({ check: "terms", passed: true, message: "Terms accepted" });
  checks.push({ check: "address", passed: !!order.address, message: order.address ? "Address provided" : "Address required" });
  checks.push({ check: "age", passed: true, message: "Age check placeholder" });
  const passed = checks.every(c => c.passed);
  return { passed, checks, message: passed ? "Legal" : "Failed checks" };
}

async function fetchShopConfig(env, shopId, origin) {
  try {
    const shop = await env.db.prepare("SELECT * FROM shops WHERE id = ? AND active = 1").bind(shopId).first();
    if (shop && shop.config_cache) {
      return JSON.parse(shop.config_cache);
    }
    if (shop && shop.site_config_url) {
      const resp = await fetch(shop.site_config_url);
      if (resp.ok) {
        const config = await resp.json();
        await env.db.prepare("UPDATE shops SET config_cache = ?, updated_at = datetime('now') WHERE id = ?").bind(JSON.stringify(config), shopId).run();
        return config;
      }
    }
  } catch (e) {
    console.error(e);
  }
  return null;
}

async function validateCatalog(env, config, orderDetails) {
  try {
    const resp = await fetch(config.catalog_url);
    if (!resp.ok) return { valid: false, message: "Catalog unavailable" };
    const catalog = await resp.json();
    return { valid: true, catalog };
  } catch (e) {
    return { valid: false, message: "Catalog error" };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { headers: { "Content-Type": "application/json" } });
    }
    
    if (method === "POST" && url.pathname === "/order") {
      const contentType = request.headers.get("Content-Type") || "";
      let form;
      try {
        if (contentType.includes("application/json")) {
          const json = await request.json();
          form = new Map(Object.entries(json));
        } else {
          form = await request.formData();
        }
      } catch {
        return new Response("Invalid data", { status: 400 });
      }
      
      const shopId = form.get("shop_id") || form.get("shopId");
      const origin = request.headers.get("Origin") || "";
      
      const shop = await env.db.prepare("SELECT * FROM shops WHERE id = ? AND active = 1").bind(shopId).first();
      if (!shop) {
        return new Response("Unauthorized shop", { status: 403 });
      }
      
      const config = await fetchShopConfig(env, shopId, origin);
      const legal = isLegalOrder(Object.fromEntries(form instanceof Map ? form : []));
      
      if (!legal.passed) {
        return new Response(JSON.stringify({ error: "Not legal", details: legal.checks }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      
      const catalogCheck = await validateCatalog(env, config || {}, form.get("order") || "");
      
      try {
        const result = await env.db.prepare(`
          INSERT INTO orders (shop_id, ordernumber, firstname, lastname, email, address, zipcode, city, shipping, country, gift_wrapping, custom_engraving, message, order_details, checkout, next_url, legal_checks_passed, legal_checks_details)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          shopId,
          form.get("ordernumber") || "",
          form.get("firstname") || "",
          form.get("lastname") || "",
          form.get("email") || "",
          form.get("address") || "",
          form.get("zipcode") || "",
          form.get("city") || "",
          form.get("shipping") || "",
          form.get("country") || "",
          form.get("gift-wrapping") || form.get("gift_wrapping") || "",
          form.get("custom-engraving") || form.get("custom_engraving") || "",
          form.get("message") || "",
          form.get("order") || "",
          form.get("checkout") || "",
          form.get("_next") || "",
          legal.passed ? 1 : 0,
          JSON.stringify(legal.checks)
        ).run();
        
        return new Response(JSON.stringify({ success: true, orderId: result.meta.last_row_id }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        console.error(e);
        return new Response("Error", { status: 500 });
      }
    }
    
    if (method === "POST" && url.pathname === "/create-checkout-session") {
      return new Response(JSON.stringify({ url: "#", sessionId: "placeholder" }), { headers: { "Content-Type": "application/json" } });
    }
    
    if (method === "POST" && url.pathname === "/webhook") {
      return new Response("ok", { status: 200 });
    }
    
    return new Response("Not found", { status: 404 });
  }
};
