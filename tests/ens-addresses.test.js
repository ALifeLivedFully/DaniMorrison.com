const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const ROOT = path.join(__dirname, "..");

function hasHugo() {
  const result = spawnSync("hugo", ["version"], { encoding: "utf8" });
  return result.status === 0;
}

function hasAttributeValue(html, value) {
  return html.includes(`data-address="${value}"`) || html.includes(`data-address=${value}`);
}

test("build-time ENS resolution populates coin addresses and falls back per coin", { timeout: 30000 }, async (t) => {
  if (!hasHugo()) {
    t.skip("hugo is not installed");
    return;
  }

  const wallets = {
    eth: "0x1111111111111111111111111111111111111111",
    btc: "bc1qensfixtureaddress000000000000000000000",
    ltc: "ltc1ensfixtureaddress000000000000000000000",
    xmr: "4ensfixtureaddress000000000000000000000000000000000000000000000000000000"
  };
  const server = http.createServer((request, response) => {
    if (request.url === "/alifelivedfully.eth") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ens: "alifelivedfully.eth", wallets }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "shop-ens-"));
  try {
    const testConfig = path.join(destination, "allow-local-ens-api.yaml");
    fs.writeFileSync(testConfig, "security:\n  http:\n    urls:\n      - '^http://127\\.0\\.0\\.1:'\n");

    const { port } = server.address();
    await execFileAsync("hugo", [
      "--quiet",
      "--config", `${path.join(ROOT, "hugo.yaml")},${testConfig}`,
      "--destination", path.join(destination, "public")
    ], {
      cwd: ROOT,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        HUGO_ENS_API_URL: `http://127.0.0.1:${port}/{name}`
      }
    });

    const html = fs.readFileSync(path.join(destination, "public", "payment", "index.html"), "utf8");
    for (const address of Object.values(wallets)) {
      assert.ok(hasAttributeValue(html, address), `missing ENS address ${address}`);
    }
    assert.ok(hasAttributeValue(html, "XtAaLWJXPMGYXhJo5GExEohZDg3K8x1xv8"),
      "missing configured fallback for a coin omitted by the ENS response");
    assert.ok(!hasAttributeValue(html, "0x1234567890123456789012345678901234567890"),
      "configured ETH placeholder should be replaced by the ENS address");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(destination, { recursive: true, force: true });
  }
});
