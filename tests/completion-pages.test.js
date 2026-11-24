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

test("each form and payment flow has its own completion page", { timeout: 30000 }, async (t) => {
  if (!hasHugo()) {
    t.skip("hugo is not installed");
    return;
  }

  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "shop-completion-"));
  try {
    await execFileAsync("hugo", [
      "--quiet",
      "--config", path.join(ROOT, "hugo.yaml"),
      "--destination", path.join(destination, "public")
    ], {
      cwd: ROOT,
      maxBuffer: 10 * 1024 * 1024
    });

    const publicDir = path.join(destination, "public");
    const read = (...parts) => fs.readFileSync(path.join(publicDir, ...parts), "utf8");

    const pages = {
      "contact-complete": "Message received",
      "newsletter-complete": "Newsletter sign-up complete",
      "enquiry-complete": "Enquiry received",
      "payment-complete": "Payment complete"
    };
    for (const [slug, heading] of Object.entries(pages)) {
      const html = read(slug, "index.html");
      assert.ok(html.includes(`<h1 id="${heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")}">${heading}</h1>`) ||
        html.includes(`># ${heading}<`), `${slug} page is missing its heading`);
    }

    const contact = read("contact", "index.html");
    assert.ok(contact.includes('<input type="hidden" name="_next" value="/contact-complete">'));

    const elements = read("elements", "index.html");
    assert.ok(elements.includes('<input type="hidden" name="_next" value="/enquiry-complete">'));
    assert.ok(elements.includes('<input type="hidden" name="_next" value="/newsletter-complete">'));

    const payment = read("payment", "index.html");
    assert.ok(payment.includes('<input type="hidden" name="_next" value="/payment-complete/">'));

    const paymentConfig = JSON.parse(read("payment.json"));
    assert.equal(paymentConfig.form.thank_you_path, "/payment-complete");
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
});
