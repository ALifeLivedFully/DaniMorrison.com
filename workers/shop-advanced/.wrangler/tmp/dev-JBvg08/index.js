var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
function isLegalOrder(order) {
  const checks = [];
  checks.push({ check: "terms", passed: true, message: "Terms accepted" });
  checks.push({ check: "address", passed: !!order.address, message: order.address ? "Address provided" : "Address required" });
  checks.push({ check: "age", passed: true, message: "Age check placeholder" });
  const passed = checks.every((c) => c.passed);
  return { passed, checks, message: passed ? "Legal" : "Failed checks" };
}
__name(isLegalOrder, "isLegalOrder");
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
__name(fetchShopConfig, "fetchShopConfig");
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
__name(validateCatalog, "validateCatalog");
var src_default = {
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

// ../../../../../../nix/store/3i2d7w4802f069g24dq33rcmyvzhghwj-wrangler-4.94.0/lib/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../../../nix/store/3i2d7w4802f069g24dq33rcmyvzhghwj-wrangler-4.94.0/lib/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-Bne9fG/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../../../nix/store/3i2d7w4802f069g24dq33rcmyvzhghwj-wrangler-4.94.0/lib/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-Bne9fG/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
