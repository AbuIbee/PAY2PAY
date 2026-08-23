import { defineConfig, devices } from "@playwright/test";

/**
 * SPRINT_20_ClosedBetaReadiness: the "end-to-end test suite" this sprint's own spec names as a
 * required deliverable. Scoped deliberately to unauthenticated/static-page coverage — this
 * environment has no disposable database (no local Postgres/Docker, confirmed by every prior
 * sprint's own documented limitation), and running authenticated flows (signup, login, payments)
 * against the linked production Supabase project would risk writing real test data into production,
 * which this sprint's own "closed-beta data safety" instruction explicitly guards against. See
 * e2e/README.md for what this does and does not cover, and what a future pass needs (a real
 * disposable staging database) to extend it to authenticated journeys.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        env: {
          APP_ENV: "test",
          DATABASE_URL: "postgres://ci:ci@localhost:5432/pay2pay_e2e",
          AUDIT_HASH_SECRET: "e2e-only-audit-hash-secret-value-not-real",
          AUTH_PASSWORD_PEPPER: "e2e-only-auth-password-pepper-value-not-real",
          NEXT_PUBLIC_APP_NAME: "PAY2PAY",
          NEXT_PUBLIC_APP_ENV: "test",
        },
      },
});
