import http from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createSqliteExecutor } from "./adapters/sqlite/executor.js";
import { SqlOrderRepository } from "./adapters/sql/order-repository.js";
import { SqlShopRepository } from "./adapters/sql/shop-repository.js";
import { createHandler } from "./http/handler.js";
import { OrderService } from "./services/order-service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = process.env.SHOP_DB_PATH || path.join(root, "shop.sqlite");
const migrationsDir = process.env.SHOP_MIGRATIONS_DIR || path.join(root, "migrations");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";

function applyMigrations(db) {
  if (process.env.SHOP_AUTO_MIGRATE === "false") return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").all().map((row) => row.name)
  );
  for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort()) {
    if (applied.has(name)) continue;
    const sql = readFileSync(path.join(migrationsDir, name), "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(name);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

async function toWebRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const origin = process.env.SHOP_ORIGIN ||
    `http://${request.headers.host || `localhost:${port}`}`;
  return new Request(new URL(request.url || "/", origin), {
    method: request.method,
    headers: request.headers,
    body: ["GET", "HEAD"].includes(request.method || "") ? undefined : body
  });
}

async function sendWebResponse(response, result) {
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  if (!result.body) {
    response.end();
    return;
  }
  for await (const chunk of result.body) response.write(chunk);
  response.end();
}

if (!existsSync(path.dirname(databasePath))) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
}

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
applyMigrations(db);

const executor = createSqliteExecutor(db);
const orderService = new OrderService(new SqlOrderRepository(executor));
const shopStore = new SqlShopRepository(executor);
const handler = createHandler({ orderService, shopStore });

const server = http.createServer(async (request, response) => {
  try {
    const webRequest = await toWebRequest(request);
    await sendWebResponse(response, await handler(webRequest));
  } catch (error) {
    console.error("Unhandled request error:", error);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader("Content-Type", "text/plain");
    }
    response.end("Internal Server Error");
  }
});

server.listen(port, host, () => {
  console.log(`Shop API listening on http://${host}:${port} using ${databasePath}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
