import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

	return defineConfig({
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					/* A test-only binding for the schema, applied once per run by the
					   setup file — the per-test storage stays isolated otherwise. */
					bindings: { TEST_MIGRATIONS: migrations },
				},
			}),
		],
		test: {
			setupFiles: ["./test/apply-migrations.mjs"],
		},
	});
});
