const CAP_VERIFY_URL = "https://cap-workers.dani-40a.workers.dev/c67674170e/siteverify";
const CAP_TIMEOUT_MS = 5000;

function capError(status, code, error, detail) {
  const result = { ok: false, status, code, error };
  if (detail) result.detail = detail;
  return result;
}

export async function verifyCapToken(secret, token) {
  if (typeof token !== "string" || !token.trim()) {
    return capError(400, "missing_token", "CAPTCHA verification is required");
  }
  if (typeof secret !== "string" || !secret.trim()) {
    return capError(503, "cap_unavailable", "CAPTCHA verification is unavailable");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CAP_TIMEOUT_MS);

  try {
    const response = await fetch(CAP_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token.trim() }),
      signal: controller.signal
    });

    let body;
    try {
      body = await response.text();
    } catch {
      return capError(502, "cap_unavailable", "CAPTCHA verification is unavailable", "unreadable Cap response");
    }

    let result;
    try {
      result = JSON.parse(body);
    } catch {
      return capError(502, "cap_unavailable", "CAPTCHA verification is unavailable", "invalid Cap response");
    }

    const detail = typeof result?.error === "string" ? result.error : "";
    const reason = detail.toLowerCase();
    if (response.ok && result?.success === true) return { ok: true };

    if (reason.includes("expir")) {
      return capError(400, "expired_token", "CAPTCHA verification expired. Please try again.", detail);
    }
    if (!response.ok && (reason.includes("site key") || reason.includes("secret"))) {
      return capError(503, "cap_unavailable", "CAPTCHA verification is unavailable", detail);
    }
    return capError(400, "invalid_token", "CAPTCHA verification failed. Please try again.", detail);
  } catch (error) {
    const code = error && error.name === "AbortError" ? "cap_timeout" : "cap_unavailable";
    const detail = error && error.message ? error.message : "";
    return capError(502, code, "CAPTCHA verification is unavailable", detail);
  } finally {
    clearTimeout(timeout);
  }
}
