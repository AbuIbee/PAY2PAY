import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

// vitest.config.ts does not enable `test.globals`, so React Testing
// Library's automatic cleanup detection (which looks for a Jest-style
// global `afterEach`) never fires on its own — register it explicitly so
// each test starts from an empty DOM.
afterEach(() => {
  cleanup();
});

// jsdom does not implement <dialog>'s showModal()/close() (a known jsdom
// gap, not a bug in our code) — Sprint 18B's StepUpChallenge and any other
// <dialog>-based UI need these to be callable in tests.
if (typeof HTMLDialogElement !== "undefined") {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
  }
}

// Test-only defaults so modules that lazily call getServerEnv() (e.g.
// AuditService) work without requiring a real .env.local in CI. These are
// not secrets — never used outside the test process.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/pay2pay_test";
process.env.AUDIT_HASH_SECRET ??= "test-only-audit-hash-secret-value";
process.env.AUTH_PASSWORD_PEPPER ??= "test-only-auth-password-pepper-value";
process.env.APP_ENV ??= "test";

// PRSprint 05 (docs/prsprints/PRSPRINT_05_DISTRIBUTED_RATE_LIMITING_ABUSE_CONTROLS.md): the
// distributed rate limiter is backed by the real Postgres database by default (src/lib/rate-limit.ts)
// — without this, any test exercising a rate-limited route without remembering its own
// `resetRateLimits()` call would attempt a real connection to the fake `DATABASE_URL` above and
// fail/hang. Applying the in-memory test store globally, before every test, removes that whole class
// of footgun rather than relying on each route test file to opt in individually — a test file's own
// explicit `resetRateLimits()` call (many already have one, for per-test isolation within a file)
// remains safe and harmless on top of this.
beforeEach(() => {
  resetRateLimits();
});
