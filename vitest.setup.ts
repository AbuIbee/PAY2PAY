import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest.config.ts does not enable `test.globals`, so React Testing
// Library's automatic cleanup detection (which looks for a Jest-style
// global `afterEach`) never fires on its own — register it explicitly so
// each test starts from an empty DOM.
afterEach(() => {
  cleanup();
});

// Test-only defaults so modules that lazily call getServerEnv() (e.g.
// AuditService) work without requiring a real .env.local in CI. These are
// not secrets — never used outside the test process.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/pay2pay_test";
process.env.AUDIT_HASH_SECRET ??= "test-only-audit-hash-secret-value";
process.env.AUTH_PASSWORD_PEPPER ??= "test-only-auth-password-pepper-value";
process.env.APP_ENV ??= "test";
