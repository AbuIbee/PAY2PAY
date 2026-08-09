import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { resetRateLimits } from "@/lib/rate-limit";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createPasswordResetRequestHandler } from "./route";

const URL = "http://localhost/api/auth/password-reset/request";

function postJson(body: unknown) {
  return new NextRequest(URL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/auth/password-reset/request", () => {
  let ctx: ReturnType<typeof createTestAuthService>;

  beforeEach(async () => {
    resetRateLimits();
    ctx = createTestAuthService();
    await ctx.authService.signup({
      email: "reset-route@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
  });

  function handlerFor() {
    return withErrorHandling(
      "auth_password_reset_request",
      createPasswordResetRequestHandler(ctx.authService),
    );
  }

  it("returns 200 for a known email and sends a reset link", async () => {
    const response = await handlerFor()(postJson({ email: "reset-route@example.com" }));
    expect(response.status).toBe(200);
    expect(ctx.emailSender.lastTokenFor("reset-route@example.com")).toBeTruthy();
  });

  it("returns the identical 200 response for an unknown email (no enumeration)", async () => {
    const known = await handlerFor()(postJson({ email: "reset-route@example.com" }));
    const unknown = await handlerFor()(postJson({ email: "nobody@example.com" }));
    expect(known.status).toBe(unknown.status);
    expect(await known.clone().json()).toEqual(await unknown.clone().json());
  });

  it("rejects a malformed email with 400", async () => {
    const response = await handlerFor()(postJson({ email: "not-an-email" }));
    expect(response.status).toBe(400);
  });
});
