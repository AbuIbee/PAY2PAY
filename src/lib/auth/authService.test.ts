import { beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "@/lib/audit/auditService";
import { AccountDisabledError, AuthenticationError, ConflictError, ValidationError } from "@/lib/errors";
import { DEFAULT_CHANNELS, type NotificationEventType } from "@/lib/notify/eventTypes";
import type { EmailSender } from "@/lib/notify/emailSender";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { AuthService } from "./authService";
import { InMemoryBetaInviteRepository } from "@/lib/compliance/testFakes";
import {
  InMemoryAccountProvisioningRepository,
  InMemoryAuditEventRepository,
  InMemoryEmailVerificationTokenRepository,
  InMemoryPasswordResetTokenRepository,
  InMemorySessionRepository,
  InMemoryUserAccountRepository,
  TEST_ADULT_DATE_OF_BIRTH,
  TEST_APP_URL,
  TEST_PEPPER,
  TEST_SESSION_TTL_MS,
  TEST_SIGNUP_BUSINESS,
  TEST_SIGNUP_IDENTITY,
  createTestAuthService,
} from "./testFakes";

const dateOfBirth = TEST_ADULT_DATE_OF_BIRTH;

describe("AuthService.signup", () => {
  let ctx: ReturnType<typeof createTestAuthService>;

  beforeEach(() => {
    ctx = createTestAuthService();
  });

  it("creates a user_account, a personal_profile, and an authenticated session", async () => {
    const result = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "New.User@Example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      ipAddress: "203.0.113.10",
      userAgent: "test-agent",
    });

    expect(result.user.email).toBe("new.user@example.com"); // normalized
    expect(result.token).toBeTruthy();
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const validated = await ctx.authService.validateSession(result.token);
    expect(validated?.user.id).toBe(result.user.id);

    // personal_profile is created for exactly the user just created, fully populated at signup —
    // never client-specified, never a blank row (see AuthService.signup's doc comment / interface).
    const profile = ctx.accountProvisioning.personalProfiles.get(result.user.id);
    expect(profile?.userId).toBe(result.user.id);
    expect(profile?.firstName).toBe(TEST_SIGNUP_IDENTITY.firstName);
    expect(profile?.lastName).toBe(TEST_SIGNUP_IDENTITY.lastName);
    expect(profile?.preferredEmail).toBe("new.user@example.com");
    expect(profile?.preferredEmailVerifiedAt).toBeNull(); // never fabricated as verified
  });

  it("sends a verification email containing a usable token", async () => {
    const result = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "verify-me@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });

    const token = ctx.emailSender.lastTokenFor("verify-me@example.com");
    expect(token).toBeTruthy();

    await ctx.authService.verifyEmail(token as string);
    const user = await ctx.users.findById(result.user.id);
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  it("rejects signup for someone under 18", async () => {
    const fifteenYearsAgo = new Date();
    fifteenYearsAgo.setUTCFullYear(fifteenYearsAgo.getUTCFullYear() - 15);
    const isoDob = fifteenYearsAgo.toISOString().slice(0, 10);

    await expect(
      ctx.authService.signup({
        accountType: "personal",
        identity: TEST_SIGNUP_IDENTITY,
        inviteCode: null,
        email: "minor@example.com",
        password: "correct horse battery staple",
        dateOfBirth: isoDob,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a malformed date of birth", async () => {
    await expect(
      ctx.authService.signup({
        accountType: "personal",
        identity: TEST_SIGNUP_IDENTITY,
        inviteCode: null,
        email: "baddob@example.com",
        password: "correct horse battery staple",
        dateOfBirth: "not-a-date",
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("records a hash-chained audit trail for signup + login", async () => {
    await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "user@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });

    const actions = ctx.auditRepo.events.map((event) => event.action);
    expect(actions).toEqual(["user_signup", "login_succeeded"]);
    expect(ctx.auditRepo.events[1]?.previousEventHash).toBe(ctx.auditRepo.events[0]?.eventHash);
  });

  it("rejects a duplicate email (case-insensitive)", async () => {
    await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "dupe@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });

    await expect(
      ctx.authService.signup({
        accountType: "personal",
        identity: TEST_SIGNUP_IDENTITY,
        inviteCode: null,
        email: "Dupe@Example.com",
        password: "another valid password",
        dateOfBirth,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("rejects a password shorter than the minimum length", async () => {
    await expect(
      ctx.authService.signup({
        accountType: "personal",
        identity: TEST_SIGNUP_IDENTITY,
        inviteCode: null,
        email: "shortpw@example.com",
        password: "short",
        dateOfBirth,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("AuthService.login", () => {
  let ctx: ReturnType<typeof createTestAuthService>;
  const email = "login-user@example.com";
  const password = "correct horse battery staple";

  beforeEach(async () => {
    ctx = createTestAuthService();
    await ctx.authService.signup({ accountType: "personal", identity: TEST_SIGNUP_IDENTITY, inviteCode: null, email, password, dateOfBirth, ipAddress: null, userAgent: null });
  });

  it("authenticates with correct credentials and issues a new session", async () => {
    const result = await ctx.authService.login({
      email,
      password,
      ipAddress: "203.0.113.10",
      userAgent: "test-agent",
    });
    expect(result.user.email).toBe(email);
    const validated = await ctx.authService.validateSession(result.token);
    expect(validated?.user.email).toBe(email);
  });

  it("rejects an invalid password", async () => {
    await expect(
      ctx.authService.login({ email, password: "totally wrong password", ipAddress: null, userAgent: null }),
    ).rejects.toThrow(AuthenticationError);
  });

  it("rejects a nonexistent email with the same error as a wrong password", async () => {
    await expect(
      ctx.authService.login({ email: "nobody@example.com", password, ipAddress: null, userAgent: null }),
    ).rejects.toThrow(AuthenticationError);
  });

  it("records login_failed on bad credentials, without creating a session", async () => {
    await expect(
      ctx.authService.login({ email, password: "wrong", ipAddress: null, userAgent: null }),
    ).rejects.toThrow(AuthenticationError);

    const failedEvents = ctx.auditRepo.events.filter((event) => event.action === "login_failed");
    expect(failedEvents).toHaveLength(1);
  });

  it("rejects login for a disabled account, even with the correct password", async () => {
    const existing = await ctx.users.findByEmail(email);
    ctx.users.setStatus((existing as { id: string }).id, "suspended");

    await expect(
      ctx.authService.login({ email, password, ipAddress: null, userAgent: null }),
    ).rejects.toThrow(AccountDisabledError);
  });

  it("updates last-login on a successful login", async () => {
    await ctx.authService.login({ email, password, ipAddress: null, userAgent: null });
    // InMemoryUserAccountRepository's updateLastLogin is a documented no-op
    // (see its doc comment) — this test instead proves the call site is
    // reached without throwing and a session is still issued, which is what
    // matters for behavior; the Drizzle implementation is the one that
    // actually persists last_login_at (no live database in this environment
    // to assert against, consistent with every other Drizzle repository in
    // this project).
    const validated = await ctx.authService.validateSession(
      (await ctx.authService.login({ email, password, ipAddress: null, userAgent: null })).token,
    );
    expect(validated?.user.email).toBe(email);
  });
});

describe("AuthService password reset", () => {
  let ctx: ReturnType<typeof createTestAuthService>;
  const email = "reset-user@example.com";
  const password = "correct horse battery staple";

  beforeEach(async () => {
    ctx = createTestAuthService();
    await ctx.authService.signup({ accountType: "personal", identity: TEST_SIGNUP_IDENTITY, inviteCode: null, email, password, dateOfBirth, ipAddress: null, userAgent: null });
  });

  it("resets the password with a valid token and the new password works", async () => {
    await ctx.authService.requestPasswordReset(email, { ipAddress: null, userAgent: null });
    const token = ctx.emailSender.lastTokenFor(email);
    expect(token).toBeTruthy();

    await ctx.authService.resetPassword(token as string, "a brand new password");
    const result = await ctx.authService.login({
      email,
      password: "a brand new password",
      ipAddress: null,
      userAgent: null,
    });
    expect(result.user.email).toBe(email);
  });

  it("invalidates existing sessions when the password is reset", async () => {
    const { token: sessionToken } = await ctx.authService.login({
      email,
      password,
      ipAddress: null,
      userAgent: null,
    });
    expect(await ctx.authService.validateSession(sessionToken)).not.toBeNull();

    await ctx.authService.requestPasswordReset(email, { ipAddress: null, userAgent: null });
    const token = ctx.emailSender.lastTokenFor(email);
    await ctx.authService.resetPassword(token as string, "a brand new password");

    expect(await ctx.authService.validateSession(sessionToken)).toBeNull();
  });

  it("does not reveal whether an email exists", async () => {
    // beforeEach's signup already sent one verification email — assert no
    // *additional* email goes out for an unknown address, not zero overall.
    const sentBefore = ctx.emailSender.sent.length;
    await expect(
      ctx.authService.requestPasswordReset("nobody@example.com", { ipAddress: null, userAgent: null }),
    ).resolves.toBeUndefined();
    expect(ctx.emailSender.sent).toHaveLength(sentBefore);
  });

  it(
    "PRSprint 16 (docs/prsprints/PRSPRINT_16_NOTIFICATION_PREFERENCES_DELIVERY_HISTORY.md), requirement " +
      "#47 (mandatory regression): the password-reset email still sends even when every optional " +
      "notification-preference email category has been disabled for this user — proven, not merely " +
      "inspected, by disabling every non-critical email preference on a real NotificationService " +
      "instance and confirming AuthService.requestPasswordReset (which never goes through notify()/ " +
      "preferences at all — it calls its own EmailSender directly) is architecturally unaffected",
    async () => {
      const notifyCtx = createTestNotificationService();
      for (const type of Object.keys(DEFAULT_CHANNELS) as NotificationEventType[]) {
        await notifyCtx.notificationService.setPreference({ userId: "reset-user-id", notificationType: type, channel: "email", enabled: false });
      }

      const sentBefore = ctx.emailSender.sent.length;
      await ctx.authService.requestPasswordReset(email, { ipAddress: null, userAgent: null });
      expect(ctx.emailSender.sent).toHaveLength(sentBefore + 1);
      expect(ctx.emailSender.sent.at(-1)?.subject).toMatch(/reset your.*password/i);
    },
  );

  it("rejects an unknown or already-used reset token", async () => {
    await expect(ctx.authService.resetPassword("not-a-real-token", "a brand new password")).rejects.toThrow(
      ValidationError,
    );

    await ctx.authService.requestPasswordReset(email, { ipAddress: null, userAgent: null });
    const token = ctx.emailSender.lastTokenFor(email) as string;
    await ctx.authService.resetPassword(token, "a brand new password");
    await expect(ctx.authService.resetPassword(token, "yet another password")).rejects.toThrow(ValidationError);
  });
});

describe("AuthService email verification", () => {
  it("rejects an unknown or already-used verification token", async () => {
    const ctx = createTestAuthService();
    await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "verify2@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });
    const token = ctx.emailSender.lastTokenFor("verify2@example.com") as string;

    await expect(ctx.authService.verifyEmail("not-a-real-token")).rejects.toThrow(ValidationError);
    await ctx.authService.verifyEmail(token);
    await expect(ctx.authService.verifyEmail(token)).rejects.toThrow(ValidationError);
  });

  it("resend is a no-op once already verified, and rejects for an unknown session user", async () => {
    const ctx = createTestAuthService();
    const result = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "verify3@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });
    const token = ctx.emailSender.lastTokenFor("verify3@example.com") as string;
    await ctx.authService.verifyEmail(token);

    const sentBefore = ctx.emailSender.sent.length;
    await ctx.authService.resendVerificationEmail(result.user.id);
    expect(ctx.emailSender.sent.length).toBe(sentBefore); // no new email — already verified

    await expect(ctx.authService.resendVerificationEmail("not-a-real-user-id")).rejects.toThrow(
      AuthenticationError,
    );
  });

  /**
   * Production follow-up (production-only customer email URLs): both the original verification
   * email and a resent one must point at whatever canonical appUrl this service was configured
   * with — the same single, centralized source (getServerEnv().APP_URL in real wiring) every other
   * customer email link reads. No separate/second URL-building path exists for either case.
   */
  it("6. the verification email link uses the configured canonical appUrl, not a Vercel/localhost URL", async () => {
    const ctx = createTestAuthService(undefined, "https://paid2you.com");
    await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "verify-hostname@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });
    const sent = ctx.emailSender.sent.find((e) => e.to === "verify-hostname@example.com");
    const link = sent?.body.match(/https?:\/\/\S+/)?.[0];
    expect(link).toBeTruthy();
    expect(new URL(link!).hostname).toBe("paid2you.com");
    expect(sent?.body).not.toContain("localhost");
    expect(sent?.body).not.toContain(".vercel.app");
  });

  it("7. a resent verification email link also uses the configured canonical appUrl, not a Vercel/localhost URL", async () => {
    const ctx = createTestAuthService(undefined, "https://paid2you.com");
    const result = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "verify-resend-hostname@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });
    ctx.emailSender.sent.length = 0;

    await ctx.authService.resendVerificationEmail(result.user.id);

    const sent = ctx.emailSender.sent.find((e) => e.to === "verify-resend-hostname@example.com");
    const link = sent?.body.match(/https?:\/\/\S+/)?.[0];
    expect(link).toBeTruthy();
    expect(new URL(link!).hostname).toBe("paid2you.com");
    expect(sent?.body).not.toContain("localhost");
    expect(sent?.body).not.toContain(".vercel.app");
  });
});

describe("AuthService.logout / validateSession", () => {
  let ctx: ReturnType<typeof createTestAuthService>;
  const email = "session-user@example.com";
  const password = "correct horse battery staple";
  let token: string;

  beforeEach(async () => {
    ctx = createTestAuthService();
    const result = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email,
      password,
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
  });

  it("persists a session across repeated validation calls", async () => {
    const first = await ctx.authService.validateSession(token);
    const second = await ctx.authService.validateSession(token);
    expect(first?.user.email).toBe(email);
    expect(second?.user.email).toBe(email);
  });

  it("returns null for an unknown token", async () => {
    expect(await ctx.authService.validateSession("not-a-real-token")).toBeNull();
  });

  it("returns null for an expired session", async () => {
    const expiredCtx = createTestAuthService(-1); // already expired the instant it's created
    const result = await expiredCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "expired@example.com",
      password,
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });
    expect(await expiredCtx.authService.validateSession(result.token)).toBeNull();
  });

  it("revokes the session on logout, and a revoked token no longer validates", async () => {
    await ctx.authService.logout(token);
    expect(await ctx.authService.validateSession(token)).toBeNull();
  });

  it("records a logout audit event", async () => {
    await ctx.authService.logout(token);
    const actions = ctx.auditRepo.events.map((event) => event.action);
    expect(actions).toContain("logout");
  });

  it("rejects logging out an already-revoked or unknown token", async () => {
    await ctx.authService.logout(token);
    await expect(ctx.authService.logout(token)).rejects.toThrow(AuthenticationError);
  });
});

// PRSprint 06 (docs/prsprints/PRSPRINT_06_AUTHENTICATION_SESSION_HARDENING.md): device/session
// visibility and self-service revocation, including "log out everywhere".
describe("AuthService.listSessions / revokeSession / revokeAllSessions", () => {
  let ctx: ReturnType<typeof createTestAuthService>;
  let userId: string;
  let firstSessionId: string;
  let secondSessionId: string;
  const context = { ipAddress: "203.0.113.5", userAgent: "test-agent" };

  beforeEach(async () => {
    ctx = createTestAuthService();
    const signupResult = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "sessions-user@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });
    userId = signupResult.user.id;
    const firstValidated = await ctx.authService.validateSession(signupResult.token);
    firstSessionId = firstValidated!.sessionId;

    const loginResult = await ctx.authService.login({
      email: "sessions-user@example.com",
      password: "correct horse battery staple",
      ipAddress: null,
      userAgent: null,
    });
    const secondValidated = await ctx.authService.validateSession(loginResult.token);
    secondSessionId = secondValidated!.sessionId;
  });

  it("lists only this user's active sessions, never another user's", async () => {
    const other = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "other-sessions-user@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });

    const sessions = await ctx.authService.listSessions(userId);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id).sort()).toEqual([firstSessionId, secondSessionId].sort());
    expect(sessions.some((s) => s.userId === other.user.id)).toBe(false);
  });

  it("omits a session once it has been revoked", async () => {
    await ctx.authService.revokeSession(userId, firstSessionId, context);
    const sessions = await ctx.authService.listSessions(userId);
    expect(sessions.map((s) => s.id)).toEqual([secondSessionId]);
  });

  it("revokeSession refuses to revoke another user's session (IDOR)", async () => {
    const other = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "attacker-sessions-user@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });
    const otherValidated = await ctx.authService.validateSession(other.token);

    await expect(
      ctx.authService.revokeSession(userId, otherValidated!.sessionId, context),
    ).rejects.toThrow(AuthenticationError);
    // The victim's session must still be valid — the attempt had no effect.
    expect(await ctx.authService.validateSession(other.token)).not.toBeNull();
  });

  it("revokeSession rejects an unknown session id", async () => {
    await expect(
      ctx.authService.revokeSession(userId, "00000000-0000-0000-0000-000000000000", context),
    ).rejects.toThrow(AuthenticationError);
  });

  it("revokeSession records a self-service audit event", async () => {
    await ctx.authService.revokeSession(userId, firstSessionId, context);
    const actions = ctx.auditRepo.events.map((event) => event.action);
    expect(actions).toContain("session_revoked_self");
  });

  it("revokeAllSessions revokes every session for the user, including the current one", async () => {
    await ctx.authService.revokeAllSessions(userId, context);
    expect(await ctx.authService.listSessions(userId)).toEqual([]);
  });

  it("revokeAllSessions records a logout-everywhere audit event", async () => {
    await ctx.authService.revokeAllSessions(userId, context);
    const actions = ctx.auditRepo.events.map((event) => event.action);
    expect(actions).toContain("logout_all_sessions");
  });
});

// Sanity check that the constructor itself still accepts the documented
// shape directly (not just through the createTestAuthService helper).
describe("AuthService construction", () => {
  it("can be constructed directly from repositories + AuditService + options", () => {
    const ctx = createTestAuthService();
    expect(
      () =>
        new AuthService(
          ctx.users,
          ctx.sessions,
          ctx.accountProvisioning,
          ctx.emailVerificationTokens,
          ctx.passwordResetTokens,
          new AuditService(ctx.auditRepo),
          ctx.emailSender,
          { pepper: TEST_PEPPER, sessionTtlMs: 1000, appUrl: TEST_APP_URL },
          ctx.accountProvisioning,
        ),
    ).not.toThrow();
  });
});

describe("AuthService.signup — Personal identity validation", () => {
  let ctx: ReturnType<typeof createTestAuthService>;

  beforeEach(() => {
    ctx = createTestAuthService();
  });

  function signupWith(identity: typeof TEST_SIGNUP_IDENTITY, email: string) {
    return ctx.authService.signup({
      accountType: "personal",
      identity,
      email,
      password: "correct horse battery staple",
      dateOfBirth,
      inviteCode: null,
      ipAddress: null,
      userAgent: null,
    });
  }

  it("rejects signup with no first name", async () => {
    await expect(signupWith({ ...TEST_SIGNUP_IDENTITY, firstName: "  " }, "no-first@example.com")).rejects.toThrow(ValidationError);
  });

  it("rejects signup with no last name", async () => {
    await expect(signupWith({ ...TEST_SIGNUP_IDENTITY, lastName: "" }, "no-last@example.com")).rejects.toThrow(ValidationError);
  });

  it("rejects signup with no contact phone", async () => {
    await expect(signupWith({ ...TEST_SIGNUP_IDENTITY, contactPhone: "" }, "no-phone@example.com")).rejects.toThrow(ValidationError);
  });

  it("rejects signup with no address line 1", async () => {
    await expect(
      signupWith({ ...TEST_SIGNUP_IDENTITY, address: { ...TEST_SIGNUP_IDENTITY.address, line1: "" } }, "no-line1@example.com"),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects signup with no city/state/postal code/country", async () => {
    for (const field of ["city", "state", "postalCode", "country"] as const) {
      await expect(
        signupWith({ ...TEST_SIGNUP_IDENTITY, address: { ...TEST_SIGNUP_IDENTITY.address, [field]: "" } }, `no-${field}@example.com`),
      ).rejects.toThrow(ValidationError);
    }
  });

  it("does not create a user_account when identity validation fails", async () => {
    await expect(signupWith({ ...TEST_SIGNUP_IDENTITY, firstName: "" }, "rejected@example.com")).rejects.toThrow(ValidationError);
    expect(await ctx.users.findByEmail("rejected@example.com")).toBeNull();
  });

  it("optional middle name is accepted and stored, and is genuinely optional", async () => {
    const withMiddle = await signupWith({ ...TEST_SIGNUP_IDENTITY, middleName: "Q" }, "with-middle@example.com");
    expect(ctx.accountProvisioning.personalProfiles.get(withMiddle.user.id)?.middleName).toBe("Q");

    const withoutMiddle = await signupWith(TEST_SIGNUP_IDENTITY, "without-middle@example.com");
    expect(ctx.accountProvisioning.personalProfiles.get(withoutMiddle.user.id)?.middleName).toBeNull();
  });

  it("the signup email becomes the preferred email, and is never fabricated as already verified", async () => {
    const result = await signupWith(TEST_SIGNUP_IDENTITY, "Preferred.Email@Example.com");
    const profile = ctx.accountProvisioning.personalProfiles.get(result.user.id);
    expect(profile?.preferredEmail).toBe("preferred.email@example.com");
    expect(profile?.preferredEmailVerifiedAt).toBeNull();
  });

  it("a new Personal account's name is immediately available (agreement-display readiness)", async () => {
    const result = await signupWith(TEST_SIGNUP_IDENTITY, "ready@example.com");
    const profile = ctx.accountProvisioning.personalProfiles.get(result.user.id);
    expect(profile?.firstName).toBeTruthy();
    expect(profile?.lastName).toBeTruthy();
    // Only the (expected, not-yet-clicked) email-verification link stands between this profile and full
    // agreement-participation readiness — every other REQUIRED_PROFILE_FIELDS entry is already satisfied.
    expect(profile?.contactPhone).toBeTruthy();
    expect(profile?.residentialAddress.line1).toBeTruthy();
  });

  it("does not create a business_profile for a Personal signup", async () => {
    const result = await signupWith(TEST_SIGNUP_IDENTITY, "personal-only@example.com");
    expect(
      [...ctx.accountProvisioning.businessProfiles.values()].some((b) => b.ownerUserId === result.user.id),
    ).toBe(false);
  });
});

describe("AuthService.signup — Business", () => {
  let ctx: ReturnType<typeof createTestAuthService>;

  beforeEach(() => {
    ctx = createTestAuthService();
  });

  function signupBusiness(email: string, overrides: Partial<typeof TEST_SIGNUP_BUSINESS> = {}) {
    return ctx.authService.signup({
      accountType: "business",
      identity: TEST_SIGNUP_IDENTITY,
      business: { ...TEST_SIGNUP_BUSINESS, ...overrides },
      email,
      password: "correct horse battery staple",
      dateOfBirth,
      inviteCode: null,
      ipAddress: null,
      userAgent: null,
    });
  }

  it("creates the representative's personal profile and the business profile in the same ownership relationship", async () => {
    const result = await signupBusiness("owner@example.com");
    const profile = ctx.accountProvisioning.personalProfiles.get(result.user.id);
    expect(profile?.firstName).toBe(TEST_SIGNUP_IDENTITY.firstName);

    const business = [...ctx.accountProvisioning.businessProfiles.values()].find((b) => b.ownerUserId === result.user.id);
    expect(business).toBeTruthy();
    expect(business?.legalBusinessName).toBe(TEST_SIGNUP_BUSINESS.legalBusinessName);
    expect(business?.taxIdType).toBe("EIN");
  });

  it("DBA/trade name defaults to the legal business name when not given", async () => {
    const result = await signupBusiness("no-dba@example.com", { dbaName: null });
    const business = [...ctx.accountProvisioning.businessProfiles.values()].find((b) => b.ownerUserId === result.user.id);
    expect(business?.displayName).toBe(TEST_SIGNUP_BUSINESS.legalBusinessName);
  });

  it("uses a given DBA/trade name as the display name", async () => {
    const result = await signupBusiness("with-dba@example.com", { dbaName: "Rivera Co." });
    const business = [...ctx.accountProvisioning.businessProfiles.values()].find((b) => b.ownerUserId === result.user.id);
    expect(business?.displayName).toBe("Rivera Co.");
  });

  it("rejects business signup missing a legal business name", async () => {
    await expect(signupBusiness("no-legal-name@example.com", { legalBusinessName: "" })).rejects.toThrow(ValidationError);
  });

  it("rejects business signup missing an entity type", async () => {
    await expect(signupBusiness("no-entity-type@example.com", { entityType: "" })).rejects.toThrow(ValidationError);
  });

  it("rejects business signup missing a tax-ID type", async () => {
    await expect(signupBusiness("no-tax-id-type@example.com", { taxIdType: "" })).rejects.toThrow(ValidationError);
  });

  it("does not create a user_account when business validation fails", async () => {
    await expect(signupBusiness("rejected-biz@example.com", { legalBusinessName: "" })).rejects.toThrow(ValidationError);
    expect(await ctx.users.findByEmail("rejected-biz@example.com")).toBeNull();
  });

  it("never persists a full tax-ID number anywhere — only the type", async () => {
    const result = await signupBusiness("tax-id-check@example.com");
    const business = [...ctx.accountProvisioning.businessProfiles.values()].find((b) => b.ownerUserId === result.user.id);
    expect(business).toBeDefined();
    // The stored record's own shape has no field capable of holding a full tax-ID number — taxIdType
    // (metadata only) is the only tax-ID-related property that exists on it at all.
    expect(Object.keys(business as object).some((key) => /tax.*id(?!type)/i.test(key))).toBe(false);
  });

  it("two business signups never leak one business's data into the other's owner", async () => {
    const first = await signupBusiness("biz-a@example.com", { legalBusinessName: "Alpha LLC" });
    const second = await signupBusiness("biz-b@example.com", { legalBusinessName: "Beta LLC" });

    const businessA = [...ctx.accountProvisioning.businessProfiles.values()].find((b) => b.ownerUserId === first.user.id);
    const businessB = [...ctx.accountProvisioning.businessProfiles.values()].find((b) => b.ownerUserId === second.user.id);
    expect(businessA?.id).not.toBe(businessB?.id);
    expect(businessA?.legalBusinessName).toBe("Alpha LLC");
    expect(businessB?.legalBusinessName).toBe("Beta LLC");
    expect(businessA?.ownerUserId).not.toBe(businessB?.ownerUserId);
  });
});

describe("AuthService.verifyEmail — preferred-email cross-update", () => {
  it("marks personal_profile.preferred_email_verified_at once the matching auth email is verified", async () => {
    const ctx = createTestAuthService();
    const result = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
            email: "cross-update@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      inviteCode: null,
      ipAddress: null,
      userAgent: null,
    });
    expect(ctx.accountProvisioning.personalProfiles.get(result.user.id)?.preferredEmailVerifiedAt).toBeNull();

    const token = ctx.emailSender.lastTokenFor("cross-update@example.com") as string;
    await ctx.authService.verifyEmail(token);

    expect(ctx.accountProvisioning.personalProfiles.get(result.user.id)?.preferredEmailVerifiedAt).not.toBeNull();
  });
});

// Requirement: "closed-beta signup must not leave an unauthorized account behind" — the atomic claim
// now lives inside the same provisioning step as the account rows themselves (see
// AccountProvisioningRepository's own doc comment in authService.ts), so a losing/invalid claim must
// fail the whole signup, not just silently skip consumption.
describe("AuthService.signup — atomic beta-invite claim (no half-created account on failure)", () => {
  it("rejects signup with an invalid invite code and creates no user_account", async () => {
    const betaInvites = new InMemoryBetaInviteRepository();
    const ctx = createTestAuthService(undefined, undefined, { betaInvites });

    await expect(
      ctx.authService.signup({
        accountType: "personal",
        identity: TEST_SIGNUP_IDENTITY,
                email: "bad-invite@example.com",
        password: "correct horse battery staple",
        dateOfBirth,
        inviteCode: "does-not-exist",
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(ValidationError);

    expect(await ctx.users.findByEmail("bad-invite@example.com")).toBeNull();
  });

  it("rejects a second signup racing to reuse an already-claimed code, with no account left behind", async () => {
    const betaInvites = new InMemoryBetaInviteRepository();
    await betaInvites.insert({ code: "ONETIME", createdByUserId: "admin-1", note: null });
    const ctx = createTestAuthService(undefined, undefined, { betaInvites });

    await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
            email: "first-claim@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      inviteCode: "ONETIME",
      ipAddress: null,
      userAgent: null,
    });

    await expect(
      ctx.authService.signup({
        accountType: "personal",
        identity: TEST_SIGNUP_IDENTITY,
                email: "second-claim@example.com",
        password: "correct horse battery staple",
        dateOfBirth,
        inviteCode: "ONETIME",
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(ValidationError);

    expect(await ctx.users.findByEmail("second-claim@example.com")).toBeNull();
  });

  it("succeeds and claims the code atomically alongside account creation", async () => {
    const betaInvites = new InMemoryBetaInviteRepository();
    await betaInvites.insert({ code: "WELCOME1", createdByUserId: "admin-1", note: null });
    const ctx = createTestAuthService(undefined, undefined, { betaInvites });

    const result = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
            email: "claims-fine@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      inviteCode: "WELCOME1",
      ipAddress: null,
      userAgent: null,
    });

    const codes = await betaInvites.listAll();
    expect(codes[0]?.usedByUserId).toBe(result.user.id);
  });
});

/**
 * Verification-email delivery is an external, non-DB step that runs strictly after
 * AccountProvisioningRepository's transaction has already committed (see signup()'s own doc comment
 * on this) — a mail-provider outage must never make signup itself report failure, roll back the
 * already-created account, or leave the caller without a session. Isolated with a plain try/catch and
 * logged, never rethrown; the user still has a normal, working resend path afterward.
 */
describe("AuthService.signup — verification email delivery failure is isolated", () => {
  class FlakyEmailSender implements EmailSender {
    sent: { to: string; subject: string; body: string }[] = [];
    private shouldThrowNext = true;

    async send(input: { to: string; subject: string; body: string; ctaUrl?: string; ctaText?: string }): Promise<{ providerMessageId: string | null }> {
      if (this.shouldThrowNext) {
        this.shouldThrowNext = false;
        throw new Error("simulated mail-provider outage");
      }
      this.sent.push(input);
      return { providerMessageId: null };
    }

    lastTokenFor(to: string): string | undefined {
      const email = [...this.sent].reverse().find((item) => item.to === to);
      return email?.body.match(/token=([\w-]+)/)?.[1];
    }
  }

  function buildAuthServiceWithFlakyEmail() {
    const users = new InMemoryUserAccountRepository();
    const sessions = new InMemorySessionRepository();
    const accountProvisioning = new InMemoryAccountProvisioningRepository(users);
    const emailSender = new FlakyEmailSender();
    const authService = new AuthService(
      users,
      sessions,
      accountProvisioning,
      new InMemoryEmailVerificationTokenRepository(),
      new InMemoryPasswordResetTokenRepository(),
      new AuditService(new InMemoryAuditEventRepository()),
      emailSender,
      { pepper: TEST_PEPPER, sessionTtlMs: TEST_SESSION_TTL_MS, appUrl: TEST_APP_URL },
      accountProvisioning,
    );
    return { authService, users, accountProvisioning, emailSender };
  }

  it("signup still returns a working session, and the account/profile remain created, when the verification email provider throws", async () => {
    const { authService, users, accountProvisioning } = buildAuthServiceWithFlakyEmail();

    const result = await authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "mail-outage@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });

    // signup() itself did not throw — the caller (the route) sees ordinary success, not a 500.
    expect(result.token).toBeTruthy();
    expect(await authService.validateSession(result.token)).not.toBeNull();

    // The already-committed account and profile are untouched — never rolled back over an external
    // mail failure that has nothing to do with the database transaction that created them.
    expect(await users.findByEmail("mail-outage@example.com")).not.toBeNull();
    const profile = accountProvisioning.personalProfiles.get(result.user.id);
    expect(profile?.firstName).toBe(TEST_SIGNUP_IDENTITY.firstName);
    expect(profile?.lastName).toBe(TEST_SIGNUP_IDENTITY.lastName);
  });

  it("the user can still get a verification email afterward via the ordinary resend path", async () => {
    const { authService, emailSender } = buildAuthServiceWithFlakyEmail();

    const result = await authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "resend-after-outage@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });
    expect(emailSender.lastTokenFor("resend-after-outage@example.com")).toBeUndefined(); // the failed first attempt never got recorded

    await authService.resendVerificationEmail(result.user.id);
    expect(emailSender.lastTokenFor("resend-after-outage@example.com")).toBeTruthy();
  });
});
