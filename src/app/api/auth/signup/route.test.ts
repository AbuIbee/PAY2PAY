import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { resetRateLimits } from "@/lib/rate-limit";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_BUSINESS, TEST_SIGNUP_IDENTITY, createTestAuthService, readSetCookie } from "@/lib/auth/testFakes";
import { createTestBetaInviteService } from "@/lib/compliance/testFakes";
import { createSignupHandler } from "./route";

const SIGNUP_URL = "http://localhost/api/auth/signup";
const dateOfBirth = TEST_ADULT_DATE_OF_BIRTH;

function personalBody(overrides: Record<string, unknown> = {}) {
  return {
    accountType: "personal",
    identity: TEST_SIGNUP_IDENTITY,
    password: "a-strong-password",
    dateOfBirth,
    ...overrides,
  };
}

function businessBody(overrides: Record<string, unknown> = {}) {
  return {
    accountType: "business",
    identity: TEST_SIGNUP_IDENTITY,
    business: TEST_SIGNUP_BUSINESS,
    password: "a-strong-password",
    dateOfBirth,
    ...overrides,
  };
}

function postJson(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(SIGNUP_URL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("POST /api/auth/signup", () => {
  let ctx: ReturnType<typeof createTestAuthService>;
  let betaCtx: ReturnType<typeof createTestBetaInviteService>;

  beforeEach(() => {
    resetRateLimits();
    betaCtx = createTestBetaInviteService();
    // Shares the same beta-invite store the route's pre-check reads from — the atomic claim itself now
    // happens inside AuthService.signup via AccountProvisioningRepository (see that interface's own doc
    // comment), so both need to observe the same underlying codes for these tests to be meaningful.
    ctx = createTestAuthService(undefined, undefined, { betaInvites: betaCtx.invites });
  });

  // Wraps the same withErrorHandling the production route uses, so thrown
  // AppErrors are asserted via their mapped status code, exactly as a real
  // client would observe them.
  function handlerFor(authService = ctx.authService, betaInviteService = betaCtx.betaInviteService) {
    return withErrorHandling("auth_signup", createSignupHandler(authService, betaInviteService));
  }

  it("creates a Personal account, returns 201, and sets a session cookie", async () => {
    const handler = handlerFor();
    const response = await handler(postJson(personalBody({ email: "new@example.com" })));

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; email: string };
    expect(body.email).toBe("new@example.com");
    expect(body).not.toHaveProperty("password");
    expect(body).not.toHaveProperty("authCredentialRef");

    const cookieValue = readSetCookie(response, "p2p_session");
    expect(cookieValue).toBeTruthy();

    const profile = ctx.accountProvisioning.personalProfiles.get(body.id);
    expect(profile?.firstName).toBe(TEST_SIGNUP_IDENTITY.firstName);
    expect(profile?.residentialAddress.line1).toBe(TEST_SIGNUP_IDENTITY.address.line1);
  });

  it("creates a Business account: representative profile + business profile, correctly owned", async () => {
    const handler = handlerFor();
    const response = await handler(postJson(businessBody({ email: "biz-owner@example.com" })));

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; email: string };

    const profile = ctx.accountProvisioning.personalProfiles.get(body.id);
    expect(profile?.firstName).toBe(TEST_SIGNUP_IDENTITY.firstName);

    const business = [...ctx.accountProvisioning.businessProfiles.values()].find((b) => b.ownerUserId === body.id);
    expect(business?.legalBusinessName).toBe(TEST_SIGNUP_BUSINESS.legalBusinessName);
    expect(business?.taxIdType).toBe("EIN");
  });

  it("rejects Personal signup missing required identity fields with 400, and creates no account", async () => {
    const handler = handlerFor();
    const response = await handler(
      postJson(personalBody({ email: "incomplete@example.com", identity: { ...TEST_SIGNUP_IDENTITY, firstName: "" } })),
    );
    expect(response.status).toBe(400);
    expect(await ctx.users.findByEmail("incomplete@example.com")).toBeNull();
  });

  it("rejects Personal signup missing a required address field with 400", async () => {
    const handler = handlerFor();
    const response = await handler(
      postJson(
        personalBody({
          email: "incomplete-address@example.com",
          identity: { ...TEST_SIGNUP_IDENTITY, address: { ...TEST_SIGNUP_IDENTITY.address, city: "" } },
        }),
      ),
    );
    expect(response.status).toBe(400);
  });

  it("never returns a tax-ID field in the response body", async () => {
    const handler = handlerFor();
    const response = await handler(postJson(businessBody({ email: "no-tax-leak@example.com" })));
    const text = await response.clone().text();
    expect(text.toLowerCase()).not.toMatch(/tax.?id.*(number|value)/);
    expect(text).not.toContain("ein_or_ssn");
  });

  it("rejects a duplicate account with 409", async () => {
    const handler = handlerFor();
    await handler(postJson(personalBody({ email: "dupe@example.com" })));
    const second = await handler(postJson(personalBody({ email: "dupe@example.com", password: "a-different-password" })));
    expect(second.status).toBe(409);
  });

  it("rejects an invalid password with 400", async () => {
    const handler = handlerFor();
    const response = await handler(postJson(personalBody({ email: "shortpw@example.com", password: "short" })));
    expect(response.status).toBe(400);
  });

  it("rejects a malformed email with 400", async () => {
    const handler = handlerFor();
    const response = await handler(postJson(personalBody({ email: "not-an-email" })));
    expect(response.status).toBe(400);
  });

  it("rejects a missing/malformed date of birth with 400", async () => {
    const handler = handlerFor();
    const response = await handler(postJson(personalBody({ email: "nodob@example.com", dateOfBirth: "not-a-date" })));
    expect(response.status).toBe(400);
  });

  it("rejects signup for someone under 18 with 400", async () => {
    const handler = handlerFor();
    const fifteenYearsAgo = new Date();
    fifteenYearsAgo.setUTCFullYear(fifteenYearsAgo.getUTCFullYear() - 15);
    const isoDob = fifteenYearsAgo.toISOString().slice(0, 10);

    const response = await handler(postJson(personalBody({ email: "minor@example.com", dateOfBirth: isoDob })));
    expect(response.status).toBe(400);
  });

  it("never returns a raw session token in the JSON body", async () => {
    const handler = handlerFor();
    const response = await handler(postJson(personalBody({ email: "leak-check@example.com" })));
    const text = await response.clone().text();
    const cookieToken = readSetCookie(response, "p2p_session");
    expect(cookieToken).toBeTruthy();
    expect(text).not.toContain(cookieToken as string);
  });

  it("rate-limits repeated signups from the same IP", async () => {
    const handler = handlerFor();
    const headers = { "x-forwarded-for": "203.0.113.5" };
    for (let i = 0; i < 5; i += 1) {
      const response = await handler(postJson(personalBody({ email: `rl-${i}@example.com` }), headers));
      expect(response.status).toBe(201);
    }
    const blocked = await handler(postJson(personalBody({ email: "rl-blocked@example.com" }), headers));
    expect(blocked.status).toBe(429);
  });

  describe(
    "PRSprint 33 (docs/prsprints/PRSPRINT_33_FINAL_PRODUCTION_LAUNCH_CONTROLS_CLOSED_BETA.md): closedBetaEnabled invite-code gate",
    () => {
      afterEach(() => {
        delete process.env.FEATURE_CLOSED_BETA_ENABLED;
      });

      it("open signup (flag off, today's default) works with no invite code at all", async () => {
        const handler = handlerFor();
        const response = await handler(postJson(personalBody({ email: "open-signup@example.com" })));
        expect(response.status).toBe(201);
      });

      it("rejects signup with a missing invite code once closed beta is enabled — and never creates an account", async () => {
        process.env.FEATURE_CLOSED_BETA_ENABLED = "true";
        const handler = handlerFor();
        const response = await handler(postJson(personalBody({ email: "no-code@example.com" })));
        expect(response.status).toBe(400);
        expect(await ctx.users.findByEmail("no-code@example.com")).toBeNull();
      });

      it("rejects signup with an unknown invite code once closed beta is enabled", async () => {
        process.env.FEATURE_CLOSED_BETA_ENABLED = "true";
        const handler = handlerFor();
        const response = await handler(
          postJson(personalBody({ email: "bad-code@example.com", inviteCode: "does-not-exist" })),
        );
        expect(response.status).toBe(400);
        expect(await ctx.users.findByEmail("bad-code@example.com")).toBeNull();
      });

      it("accepts signup with a valid, unused invite code once closed beta is enabled, and consumes the code atomically", async () => {
        process.env.FEATURE_CLOSED_BETA_ENABLED = "true";
        await betaCtx.invites.insert({ code: "WELCOME1", createdByUserId: "admin-1", note: null });
        const handler = handlerFor();
        const response = await handler(
          postJson(personalBody({ email: "good-code@example.com", inviteCode: "WELCOME1" })),
        );
        expect(response.status).toBe(201);
        const codes = await betaCtx.invites.listAll();
        expect(codes[0]?.usedByUserId).toBeTruthy();
      });

      it("rejects a second signup attempt reusing an already-consumed invite code, with no account left behind", async () => {
        process.env.FEATURE_CLOSED_BETA_ENABLED = "true";
        await betaCtx.invites.insert({ code: "ONETIME", createdByUserId: "admin-1", note: null });
        const handler = handlerFor();
        await handler(postJson(personalBody({ email: "first-user@example.com", inviteCode: "ONETIME" })));

        const second = await handler(
          postJson(personalBody({ email: "second-user@example.com", inviteCode: "ONETIME" })),
        );
        expect(second.status).toBe(400);
        expect(await ctx.users.findByEmail("second-user@example.com")).toBeNull();
      });
    },
  );
});
