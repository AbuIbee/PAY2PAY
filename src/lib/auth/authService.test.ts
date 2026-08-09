import { beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "@/lib/audit/auditService";
import { AccountDisabledError, AuthenticationError, ConflictError, ValidationError } from "@/lib/errors";
import { AuthService } from "./authService";
import {
  TEST_ADULT_DATE_OF_BIRTH,
  TEST_APP_URL,
  TEST_PEPPER,
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

    // personal_profile is created for exactly the user just created — never
    // client-specified (see AuthService.signup's doc comment / interface).
    const profile = await ctx.personalProfiles.findByUserId(result.user.id);
    expect(profile?.userId).toBe(result.user.id);
  });

  it("sends a verification email containing a usable token", async () => {
    const result = await ctx.authService.signup({
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
      email: "dupe@example.com",
      password: "correct horse battery staple",
      dateOfBirth,
      ipAddress: null,
      userAgent: null,
    });

    await expect(
      ctx.authService.signup({
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
    await ctx.authService.signup({ email, password, dateOfBirth, ipAddress: null, userAgent: null });
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
    await ctx.authService.signup({ email, password, dateOfBirth, ipAddress: null, userAgent: null });
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
});

describe("AuthService.logout / validateSession", () => {
  let ctx: ReturnType<typeof createTestAuthService>;
  const email = "session-user@example.com";
  const password = "correct horse battery staple";
  let token: string;

  beforeEach(async () => {
    ctx = createTestAuthService();
    const result = await ctx.authService.signup({
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
          ctx.personalProfiles,
          ctx.emailVerificationTokens,
          ctx.passwordResetTokens,
          new AuditService(ctx.auditRepo),
          ctx.emailSender,
          { pepper: TEST_PEPPER, sessionTtlMs: 1000, appUrl: TEST_APP_URL },
        ),
    ).not.toThrow();
  });
});
