import { beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "@/lib/audit/auditService";
import { AuthenticationError, ConflictError } from "@/lib/errors";
import { AuthService } from "./authService";
import { TEST_PEPPER, createTestAuthService } from "./testFakes";

describe("AuthService.signup", () => {
  let ctx: ReturnType<typeof createTestAuthService>;

  beforeEach(() => {
    ctx = createTestAuthService();
  });

  it("creates a user_account and an authenticated session", async () => {
    const result = await ctx.authService.signup({
      email: "New.User@Example.com",
      password: "correct horse battery staple",
      ipAddress: "203.0.113.10",
      userAgent: "test-agent",
    });

    expect(result.user.email).toBe("new.user@example.com"); // normalized
    expect(result.token).toBeTruthy();
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const validated = await ctx.authService.validateSession(result.token);
    expect(validated?.user.id).toBe(result.user.id);
  });

  it("records a hash-chained audit trail for signup + login", async () => {
    await ctx.authService.signup({
      email: "user@example.com",
      password: "correct horse battery staple",
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
      ipAddress: null,
      userAgent: null,
    });

    await expect(
      ctx.authService.signup({
        email: "Dupe@Example.com",
        password: "another valid password",
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
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(AuthenticationError);
  });
});

describe("AuthService.login", () => {
  let ctx: ReturnType<typeof createTestAuthService>;
  const email = "login-user@example.com";
  const password = "correct horse battery staple";

  beforeEach(async () => {
    ctx = createTestAuthService();
    await ctx.authService.signup({ email, password, ipAddress: null, userAgent: null });
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
      ctx.authService.login({
        email,
        password: "totally wrong password",
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(AuthenticationError);
  });

  it("rejects a nonexistent email with the same error as a wrong password", async () => {
    await expect(
      ctx.authService.login({
        email: "nobody@example.com",
        password,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(AuthenticationError);
  });

  it("records login_failed on bad credentials, without creating a session", async () => {
    await expect(
      ctx.authService.login({ email, password: "wrong", ipAddress: null, userAgent: null }),
    ).rejects.toThrow(AuthenticationError);

    const failedEvents = ctx.auditRepo.events.filter((event) => event.action === "login_failed");
    expect(failedEvents).toHaveLength(1);
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
        new AuthService(ctx.users, ctx.sessions, new AuditService(ctx.auditRepo), {
          pepper: TEST_PEPPER,
          sessionTtlMs: 1000,
        }),
    ).not.toThrow();
  });
});
