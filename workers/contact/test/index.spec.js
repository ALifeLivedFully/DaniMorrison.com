import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src";

const ORIGIN = "https://danimorrison.com";

function submission(overrides = {}) {
  return {
    name: "Test Person",
    email: "test@example.com",
    message: "Hello there",
    terms: "I accept the terms and conditions",
    _next: "/thankyou/",
    ...overrides,
  };
}

function formBody(data) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) params.set(key, value);
  }
  return params.toString();
}

async function rows() {
  const result = await env.contact
    .prepare("SELECT * FROM contact_submissions ORDER BY id")
    .all();
  return result.results;
}

describe("contact worker", () => {
  beforeEach(async () => {
    await env.contact.prepare("DELETE FROM contact_submissions").run();
  });

  it("reports health", async () => {
    const response = await SELF.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("greets plain GETs", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Ready to receive form submissions");
  });

  it("rejects other methods", async () => {
    const response = await SELF.fetch("https://example.com/", { method: "PUT" });
    expect(response.status).toBe(405);
  });

  it("stores a JSON submission and redirects to _next", async () => {
    const request = new Request("https://example.com/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "User-Agent": "vitest",
        "CF-Connecting-IP": "203.0.113.10"
      },
      body: JSON.stringify(submission()),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/thankyou/`);

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe("Test Person");
    expect(stored[0].email).toBe("test@example.com");
    expect(stored[0].message).toBe("Hello there");
    expect(JSON.parse(stored[0].payload).terms).toBe("I accept the terms and conditions");
    expect(stored[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0].ua_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores a form-encoded submission", async () => {
    const request = new Request("https://example.com/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: ORIGIN,
      },
      body: formBody(submission({ message: "Form post" })),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/thankyou/`);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].message).toBe("Form post");
  });

  it("returns 201 without a redirect when no Origin is sent", async () => {
    const response = await SELF.fetch("https://example.com/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission({ _next: undefined })),
    });

    expect(response.status).toBe(201);
    expect(await rows()).toHaveLength(1);
  });

  it("swallows honeypot submissions without storing them", async () => {
    const response = await SELF.fetch("https://example.com/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(submission({ website: "http://spam.example" })),
    });

    expect(response.status).toBe(200);
    expect(await rows()).toHaveLength(0);
  });

  it("requires a name", async () => {
    const response = await SELF.fetch("https://example.com/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(submission({ name: "" })),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "missing_name" });
    expect(await rows()).toHaveLength(0);
  });

  it("requires a valid email address", async () => {
    const response = await SELF.fetch("https://example.com/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(submission({ email: "not-an-email" })),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_email" });
    expect(await rows()).toHaveLength(0);
  });
});
