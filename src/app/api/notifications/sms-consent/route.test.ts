import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createSmsConsentGetHandler, createSmsConsentSetHandler } from "./route";

function getWithCookie(sessionToken?: string) {
  const headers: Record<string, string> = sessionToken ? { cookie: `p2p_session=${sessionToken}` } : {};
  return new NextRequest("http://localhost/api/notifications/sms-consent", { method: "GET", headers });
}

function postWithCookie(body: unknown, sessionToken?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sessionToken) headers.cookie = `p2p_session=${sessionToken}`;
  return new NextRequest("http://localhost/api/notifications/sms-consent", { method: "POST", headers, body: JSON.stringify(body) });
}

/** B0-B: this route touches genuine consent state, so every test here uses the strict, real-world default (no consent unless explicitly granted) rather than the shared factory's permissive convenience — see testFakes.ts's own doc comment on `smsConsentDefaultActive`. */
describe("/api/notifications/sms-consent (B0-B)", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let notifyCtx: ReturnType<typeof createTestNotificationService>;

  beforeEach(() => {
    authCtx = createTestAuthService();
    notifyCtx = createTestNotificationService(undefined, undefined, false);
  });

  function getHandler() {
    return withErrorHandling("sms_consent_get", createSmsConsentGetHandler(authCtx.authService, notifyCtx.notificationService));
  }

  function setHandler() {
    return withErrorHandling("sms_consent_set", createSmsConsentSetHandler(authCtx.authService, notifyCtx.notificationService));
  }

  async function signup(email: string) {
    return authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
  }

  describe("GET", () => {
    it("17: rejects an unauthenticated request (401) — cannot read anyone's consent state anonymously", async () => {
      const response = await getHandler()(getWithCookie());
      expect(response.status).toBe(401);
    });

    it("1/3: a user with no recorded consent sees active/effectiveActive OFF", async () => {
      const result = await signup("user@example.com");
      const response = await getHandler()(getWithCookie(result.token));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.active).toBe(false);
      expect(body.effectiveActive).toBe(false);
    });
  });

  describe("POST", () => {
    it("17: rejects an unauthenticated request (401) — an anonymous caller cannot alter anyone's consent", async () => {
      const response = await setHandler()(postWithCookie({ enabled: true }));
      expect(response.status).toBe(401);
    });

    it("2/4: rejects enabling consent with no verified phone on file (the activation itself throws, surfaced as a 4xx)", async () => {
      const result = await signup("user@example.com");
      const response = await setHandler()(postWithCookie({ enabled: true }, result.token));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      const status = await notifyCtx.notificationService.getSmsConsentStatus(result.user.id);
      expect(status.active).toBe(false);
    });

    it("3/4/5: enabling with a verified phone persists active consent with a timestamp/source/version", async () => {
      const result = await signup("user@example.com");
      notifyCtx.contacts.setPhone(result.user.id, "+15551234567");
      const response = await setHandler()(postWithCookie({ enabled: true }, result.token));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.active).toBe(true);
      expect(body.effectiveActive).toBe(true);
      const status = await notifyCtx.notificationService.getSmsConsentStatus(result.user.id);
      expect(status.consentedAt).not.toBeNull();
      expect(status.source).toBe("web_form");
      expect(status.disclosureVersion).toBeTruthy();
    });

    it("6: disabling persists withdrawal", async () => {
      const result = await signup("user@example.com");
      notifyCtx.contacts.setPhone(result.user.id, "+15551234567");
      await setHandler()(postWithCookie({ enabled: true }, result.token));
      const response = await setHandler()(postWithCookie({ enabled: false }, result.token));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.active).toBe(false);
      const status = await notifyCtx.notificationService.getSmsConsentStatus(result.user.id);
      expect(status.withdrawnAt).not.toBeNull();
    });

    it("16/17: a caller can only ever change their OWN consent — a body-smuggled userId for another registered user is ignored entirely", async () => {
      const userA = await signup("usera@example.com");
      const userB = await signup("userb@example.com");
      notifyCtx.contacts.setPhone(userA.user.id, "+15551234567");
      notifyCtx.contacts.setPhone(userB.user.id, "+15559876543");

      // userA's own session, but the body attempts to smuggle userB's id.
      const response = await setHandler()(postWithCookie({ userId: userB.user.id, enabled: true }, userA.token));
      expect(response.status).toBe(200);

      const statusA = await notifyCtx.notificationService.getSmsConsentStatus(userA.user.id);
      const statusB = await notifyCtx.notificationService.getSmsConsentStatus(userB.user.id);
      expect(statusA.active).toBe(true); // userA's own consent was the one actually changed.
      expect(statusB.active).toBe(false); // userB's consent is untouched.
    });

    it("rejects a malformed body (missing/wrong-typed enabled)", async () => {
      const result = await signup("user@example.com");
      const response = await setHandler()(postWithCookie({ enabled: "yes" }, result.token));
      expect(response.status).toBe(400);
    });
  });
});
