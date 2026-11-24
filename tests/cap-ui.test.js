const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, "..");

function hasHugo() {
  const result = spawnSync("hugo", ["version"], { encoding: "utf8" });
  return result.status === 0;
}

test("the built site loads Cap locally and mounts it on protected forms", { timeout: 30000 }, async (t) => {
  if (!hasHugo()) {
    t.skip("hugo is not installed");
    return;
  }

  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "shop-cap-"));
  try {
    await execFileAsync("hugo", [
      "--quiet",
      "--config", path.join(ROOT, "hugo.yaml"),
      "--destination", path.join(destination, "public")
    ], {
      cwd: ROOT,
      maxBuffer: 10 * 1024 * 1024
    });

    const contact = fs.readFileSync(path.join(destination, "public", "contact", "index.html"), "utf8");
    const checkout = fs.readFileSync(path.join(destination, "public", "checkout", "index.html"), "utf8");
    const payment = fs.readFileSync(path.join(destination, "public", "payment", "index.html"), "utf8");

    for (const html of [contact, checkout, payment]) {
      assert.ok(html.includes('/vendor/cap/cap-widget-0.1.64.min.js'));
      assert.ok(html.includes('/js/cap-invisible.js'));
      assert.ok(html.includes('window.CAP_CUSTOM_WASM_URL = "/vendor/cap/cap_wasm_bg-0.0.8.wasm"'));
      assert.ok(html.includes('window.CAP_CUSTOM_HASHWX_URL = "/vendor/cap/hashwx-0.0.8.wasm"'));
      assert.ok(html.includes('window.CAP_PAKO_URL = "/vendor/cap/pako_inflate-2.1.0.min.js"'));
      assert.ok(!html.includes("cdn.jsdelivr.net"));
      assert.ok(!html.includes("<cap-widget"));
    }
    assert.ok(contact.includes('data-cap-endpoint="https://cap-workers.dani-40a.workers.dev/c67674170e/"'));
    assert.ok(checkout.includes('data-cap-endpoint="https://cap-workers.dani-40a.workers.dev/c67674170e/"'));
    assert.ok(contact.includes('<input type="hidden" name="cap-token" value="">'));
    assert.ok(checkout.includes('<input type="hidden" name="cap-token" value="">'));
    assert.ok(payment.includes('data-cap-endpoint="https://cap-workers.dani-40a.workers.dev/c67674170e/"'));
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
});
