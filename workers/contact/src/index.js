const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function text(request, body, status = 200) {
  return new Response(body, { status, headers: corsHeaders(request) });
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) }
  });
}

async function hash(value) {
  if (!value) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formObject(form) {
  return Object.fromEntries([...form.entries()].map(([key, value]) => [
    key,
    typeof value === "string" ? value.trim() : value
  ]));
}

async function readBody(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    try {
      const value = await request.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      return value;
    } catch {
      return null;
    }
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      return formObject(await request.formData());
    } catch {
      return null;
    }
  }
  return null;
}

function submittingOrigin(request) {
  const header = request.headers.get("Origin");
  if (!header || header === "null") return null;
  try {
    return new URL(header).origin;
  } catch {
    return null;
  }
}

async function storeSubmission(env, data, request) {
  const [ipHash, uaHash] = await Promise.all([
    hash(request.headers.get("CF-Connecting-IP")),
    hash(request.headers.get("User-Agent"))
  ]);
  await env.contact
    .prepare(
      `INSERT INTO contact_submissions (name, email, message, terms, payload, ip_hash, ua_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      data.name,
      data.email,
      data.message || null,
      data.terms || null,
      JSON.stringify(data),
      ipHash,
      uaHash
    )
    .run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (method === "GET") {
      if (url.pathname === "/health") {
        return json(request, { status: "ok" });
      }
      return text(request, "Ready to receive form submissions!");
    }

    if (method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, POST, OPTIONS", ...corsHeaders(request) }
      });
    }

    const data = await readBody(request);
    if (!data) return text(request, "Invalid data", 400);

    if (data.website || data._gotcha) {
      return text(request, "Submission received");
    }

    const name = String(data.name || "").trim();
    const email = String(data.email || "").trim();
    if (!name) {
      return json(request, { error: "name is required", code: "missing_name" }, 400);
    }
    if (!EMAIL_PATTERN.test(email)) {
      return json(request, { error: "a valid email address is required", code: "invalid_email" }, 400);
    }

    try {
      await storeSubmission(env, data, request);
    } catch (error) {
      console.error("Contact submission failed:", error);
      return json(request, { error: "Could not save the submission." }, 500);
    }

    const origin = submittingOrigin(request);
    const next = data._next
      ? new URL(String(data._next), origin || request.url)
      : null;
    if (next && origin) {
      return Response.redirect(next.href, 303);
    }
    return text(request, "Submission received", 201);
  }
};
