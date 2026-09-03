import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createNotificationPreferencesGetHandler, createNotificationPreferencesSetHandler } from "./route";

function getWithCookie(sessionToken?: string) {
  const headers: Record<string, string> = sessionToken ? { cookie: `p2p_session=${sessionToken}` } : {};
  return new NextRequest("http://localhost/api/notifications/preferences", { method: "GET", headers });
}

function postWithCookie(body: unknown, sessionToken?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sessionToken) headers.cookie = `p2p_session=${sessionToken}`;
  return new NextRequest("http://localhost/api/notifications/preferences", { method: "POST", headers, body: JSON.stringify(body) });
}

describe("/api/notifications/preferences", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let notifyCtx: ReturnType<typeof createTestNotificationService>;

  beforeEach(() => {
    authCtx = createTestAuthService();
    notifyCtx = createTestNotificationService();
  });

  function getHandler() {
    return withErrorHandling("notification_preferences_get", createNotificationPreferencesGetHandler(authCtx.authService, notifyCtx.notificationService));
  }

  function setHandler() {
    return withErrorHandling("notification_preferences_set", createNotificationPreferencesSetHandler(authCtx.authService, notifyCtx.notificationService));
  }

  describe("GET", () => {
    it("rejects a request with no session at all (401)", async () => {
      const response = await getHandler()(getWithCookie());
      expect(response.status).toBe(401);
    });

    it("returns the caller's own preferences plus smsEligibility/smsProviderAvailable, never infrastructure terms", async () => {
      const result = await authCtx.authService.signup({
        accountType: "personal",
        identity: TEST_SIGNUP_IDENTITY,
        inviteCode: null,
        email: "user@example.com",
        password: "a-strong-password",
        dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
        ipAddress: null,
        userAgent: null,
      });
      const response = await getHandler()(getWithCookie(result.token));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body.preferences)).toBe(true);
      expect(body.smsEligibility).toEqual({ phoneVerified: false, maskedPhone: null, optedOut: false });
      expect(typeof body.smsProviderAvailable).toBe("boolean");
      expect(JSON.stringify(body).toLowerCase()).not.toContain("twilio");
    });
  });

  describe("POST", () => {
    it("rejects a request with no session at all (401)", async () => {
      const response = await setHandler()(postWithCookie({ notificationType: "amendment", channel: "email", enabled: false }));
      expect(response.status).toBe(401);
    });

    it("rejects an unrecognized notificationType (400)", async () => {
      const result = await authCtx.authService.signup({
        accountType: "personal",
        identity: TEST_SIGNUP_IDENTITY,
        inviteCode: null,
        email: "user@example.com",
        password: "a-strong-password",
        dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
        ipAddress: null,
        userAgent: null,
      });
      const response = await setHandler()(postWithCookie({ notificationType: "not_a_real_type", channel: "email", enabled: false }, result.token));
      expect(response.status).toBe(400);
    });

    it("a caller can only ever change their own preferences — userId is never accepted from the request body", async () => {
      const userA = await authCtx.authService.signup({
        accountType: "personal",
        identity: TEST_SIGNUP_IDENTITY,
        inviteCode: null,
        email: "usera@example.com",
        password: "a-strong-password",
        dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
        ipAddress: null,
        userAgent: null,
      });
      const userB = await authCtx.authService.signup({
        accountType: "personal",
        identity: TEST_SIGNUP_IDENTITY,
        inviteCode: null,
        email: "userb@example.com",
        password: "a-strong-password",
        dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
        ipAddress: null,
        userAgent: null,
      });

      // userA's own session, but the body attempts to smuggle userB's id — the route must ignore it entirely.
      const response = await setHandler()(
        postWithCookie({ userId: userB.user.id, notificationType: "amendment", channel: "email", enabled: false }, userA.token),
      );
      expect(response.status).toBe(200);

      const userAPrefs = await notifyCtx.preferences.listForUser(userA.user.id);
      const userBPrefs = await notifyCtx.preferences.listForUser(userB.user.id);
      expect(userAPrefs.some((p) => p.notificationType === "amendment" && p.channel === "email" && !p.enabled)).toBe(true);
      expect(userBPrefs).toHaveLength(0);
    });

    it("cannot disable a critical notification type — the write is a structural no-op", async () => {
      const result = await authCtx.authService.signup({
        accountType: "personal",
        identity: TEST_SIGNUP_IDENTITY,
        inviteCode: null,
        email: "user@example.com",
        password: "a-strong-password",
        dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
        ipAddress: null,
        userAgent: null,
      });
      const response = await setHandler()(postWithCookie({ notificationType: "payment_failed", channel: "email", enabled: false }, result.token));
      expect(response.status).toBe(200); // silently no-ops, does not error
      const prefs = await notifyCtx.preferences.listForUser(result.user.id);
      expect(prefs.some((p) => p.notificationType === "payment_failed")).toBe(false);
    });
  });
});
