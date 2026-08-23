import { test, expect } from "@playwright/test";

/**
 * SPRINT_20_ClosedBetaReadiness: confirms the security headers Sprint 19 added in next.config.ts
 * (headers(), not middleware) are actually present on real HTTP responses, not just declared in config.
 */
test("security headers are present on the homepage response", async ({ request }) => {
  const response = await request.get("/");
  const headers = response.headers();

  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["strict-transport-security"]).toContain("max-age=63072000");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"]).toContain("camera=()");
});

test("security headers are present on an API response", async ({ request }) => {
  const response = await request.get("/api/auth/me");
  const headers = response.headers();

  expect(headers["content-security-policy"]).toBeTruthy();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
});

test("production CSP does not permit unsafe-eval (dev-only exemption must not leak into prod)", async ({ request }) => {
  test.skip(process.env.NODE_ENV !== "production", "only meaningful when the server under test runs in production mode");
  const response = await request.get("/");
  const csp = response.headers()["content-security-policy"] ?? "";
  expect(csp).not.toContain("unsafe-eval");
});
