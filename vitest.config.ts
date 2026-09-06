import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Next.js's bundler no-ops this import for server code at build time;
      // Vitest has no such build step, so it's aliased to a stub here.
      // See test/stubs/server-only.ts for why this is safe.
      "server-only": path.resolve(__dirname, "./test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // R07 (DB integrity & concurrency hardening): `*.postgres.test.ts` suites require a real,
    // disposable Postgres database (provisioned only by `npm run test:postgres`, see
    // vitest.postgres.config.ts) — excluded here so the ordinary `vitest run`/`npm test` never
    // attempts them against whatever DATABASE_URL happens to be set (or the fake default
    // vitest.setup.ts provides), which would otherwise fail or silently pass against nothing.
    exclude: ["**/*.postgres.test.ts"],
    css: false,
  },
});
