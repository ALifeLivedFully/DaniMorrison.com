const CAP_VERIFY_URL = "https://cap-workers.dani-40a.workers.dev/c67674170e/siteverify";
const CAP_TIMEOUT_MS = 5000;

function capError(status, code, error) {
  return { ok: false, status, code, error };
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
    if (!response.ok) {
      return capError(502, "cap_unavailable", "CAPTCHA verification is unavailable");
    }

    let result;
    try {
      result = await response.json();
    } catch {
      return capError(502, "cap_unavailable", "CAPTCHA verification is unavailable");
    }
    if (result && result.success === true) return { ok: true };

    const reason = String((result && result.error) || "").toLowerCase();
    if (reason.includes("expir")) {
      return capError(400, "expired_token", "CAPTCHA verification expired. Please try again.");
    }
    return capError(400, "invalid_token", "CAPTCHA verification failed. Please try again.");
  } catch (error) {
    const code = error && error.name === "AbortError" ? "cap_timeout" : "cap_unavailable";
    return capError(502, code, "CAPTCHA verification is unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
