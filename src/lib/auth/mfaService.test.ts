import { beforeEach, describe, expect, it } from "vitest";
import { computeTotpCode } from "./totp";
import { createTestMfaService } from "./mfaTestFakes";

const USER_ID = "user-1";
const SESSION_ID = "session-1";
const ACTION = "sign_agreement";

describe("MfaService", () => {
  let ctx: ReturnType<typeof createTestMfaService>;

  beforeEach(() => {
    ctx = createTestMfaService();
  });

  it("has no verified method before enrollment, so requireStepUp fails closed", async () => {
    expect(await ctx.mfaService.hasVerifiedMethod(USER_ID)).toBe(false);
    const passed = await ctx.mfaService.requireStepUp({ userId: USER_ID, sessionId: SESSION_ID, action: ACTION });
    expect(passed).toBe(false);
  });

  it("enrolls a passkey authenticator app (TOTP) end to end", async () => {
    const { secret } = await ctx.mfaService.beginTotpEnrollment(USER_ID, "user@example.com");
    expect(await ctx.mfaService.hasVerifiedMethod(USER_ID)).toBe(false); // not verified yet

    const code = computeTotpCode(secret);
    await ctx.mfaService.confirmTotpEnrollment(USER_ID, code);
    expect(await ctx.mfaService.hasVerifiedMethod(USER_ID)).toBe(true);
  });

  it("rejects an incorrect TOTP enrollment code", async () => {
    await ctx.mfaService.beginTotpEnrollment(USER_ID, "user@example.com");
    await expect(ctx.mfaService.confirmTotpEnrollment(USER_ID, "000000")).rejects.toThrow();
    expect(await ctx.mfaService.hasVerifiedMethod(USER_ID)).toBe(false);
  });

  it("enrolls SMS as a fallback method, only after the correct code is confirmed", async () => {
    await ctx.mfaService.beginSmsEnrollment(USER_ID, "+15551234567");
    const code = ctx.smsSender.lastCodeFor("+15551234567");
    expect(code).toBeTruthy();
    expect(await ctx.mfaService.hasVerifiedMethod(USER_ID)).toBe(false);

    await ctx.mfaService.confirmSmsEnrollment(USER_ID, code as string);
    expect(await ctx.mfaService.hasVerifiedMethod(USER_ID)).toBe(true);
  });

  it("does not prefer SMS over TOTP when both are available (SMS is fallback-only in the UI, not enforced here — this documents current behavior)", async () => {
    const { secret } = await ctx.mfaService.beginTotpEnrollment(USER_ID, "user@example.com");
    await ctx.mfaService.confirmTotpEnrollment(USER_ID, computeTotpCode(secret));
    await ctx.mfaService.beginSmsEnrollment(USER_ID, "+15551234567");
    await ctx.mfaService.confirmSmsEnrollment(USER_ID, ctx.smsSender.lastCodeFor("+15551234567") as string);

    const verified = await ctx.credentials.findVerifiedByUserId(USER_ID);
    expect(verified.map((c) => c.method).sort()).toEqual(["sms", "totp"]);
  });

  it("blocks a sensitive action with no MFA enrolled", async () => {
    const passed = await ctx.mfaService.requireStepUp({ userId: USER_ID, sessionId: SESSION_ID, action: ACTION });
    expect(passed).toBe(false);
  });

  it("requires a step-up challenge to be completed before requireStepUp passes", async () => {
    const { secret } = await ctx.mfaService.beginTotpEnrollment(USER_ID, "user@example.com");
    await ctx.mfaService.confirmTotpEnrollment(USER_ID, computeTotpCode(secret));

    expect(await ctx.mfaService.requireStepUp({ userId: USER_ID, sessionId: SESSION_ID, action: ACTION })).toBe(
      false,
    );

    const ok = await ctx.mfaService.completeStepUp({
      userId: USER_ID,
      sessionId: SESSION_ID,
      method: "totp",
      code: computeTotpCode(secret),
      action: ACTION,
    });
    expect(ok).toBe(true);
    expect(await ctx.mfaService.requireStepUp({ userId: USER_ID, sessionId: SESSION_ID, action: ACTION })).toBe(
      true,
    );
  });

  it("step-up completed on one session does not authorize a different session", async () => {
    const { secret } = await ctx.mfaService.beginTotpEnrollment(USER_ID, "user@example.com");
    await ctx.mfaService.confirmTotpEnrollment(USER_ID, computeTotpCode(secret));
    await ctx.mfaService.completeStepUp({
      userId: USER_ID,
      sessionId: SESSION_ID,
      method: "totp",
      code: computeTotpCode(secret),
      action: ACTION,
    });

    const otherSession = await ctx.mfaService.requireStepUp({
      userId: USER_ID,
      sessionId: "session-2",
      action: ACTION,
    });
    expect(otherSession).toBe(false);
  });

  it("step-up session freshness expires and must be redone", async () => {
    // 0ms freshness window so the grant is immediately expired.
    const shortLived = createTestMfaService({ stepUpFreshnessMs: 0 });
    const { secret } = await shortLived.mfaService.beginTotpEnrollment(USER_ID, "user@example.com");
    await shortLived.mfaService.confirmTotpEnrollment(USER_ID, computeTotpCode(secret));
    await shortLived.mfaService.completeStepUp({
      userId: USER_ID,
      sessionId: SESSION_ID,
      method: "totp",
      code: computeTotpCode(secret),
      action: ACTION,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      await shortLived.mfaService.requireStepUp({ userId: USER_ID, sessionId: SESSION_ID, action: ACTION }),
    ).toBe(false);
  });

  it("rejects an SMS step-up code after too many incorrect attempts", async () => {
    await ctx.mfaService.beginSmsEnrollment(USER_ID, "+15551234567");
    await ctx.mfaService.confirmSmsEnrollment(USER_ID, ctx.smsSender.lastCodeFor("+15551234567") as string);
    await ctx.mfaService.initiateStepUp(USER_ID, "sms");

    for (let i = 0; i < 5; i += 1) {
      const ok = await ctx.mfaService.completeStepUp({
        userId: USER_ID,
        sessionId: SESSION_ID,
        method: "sms",
        code: "000000",
        action: ACTION,
      });
      expect(ok).toBe(false);
    }

    const realCode = ctx.smsSender.lastCodeFor("+15551234567") as string;
    const ok = await ctx.mfaService.completeStepUp({
      userId: USER_ID,
      sessionId: SESSION_ID,
      method: "sms",
      code: realCode,
      action: ACTION,
    });
    expect(ok).toBe(false); // locked out after too many attempts, even with the correct code
  });

  it("has no bypass path: disabling all methods removes the ability to pass requireStepUp again", async () => {
    const { secret } = await ctx.mfaService.beginTotpEnrollment(USER_ID, "user@example.com");
    const code = computeTotpCode(secret);
    await ctx.mfaService.confirmTotpEnrollment(USER_ID, code);
    const grantedStepUp = await ctx.mfaService.completeStepUp({
      userId: USER_ID,
      sessionId: SESSION_ID,
      method: "totp",
      code,
      action: "mfa_disable",
    });
    expect(grantedStepUp).toBe(true);

    await ctx.mfaService.disableMethod(USER_ID, SESSION_ID, "totp");

    expect(await ctx.mfaService.hasVerifiedMethod(USER_ID)).toBe(false);
    const ok = await ctx.mfaService.completeStepUp({
      userId: USER_ID,
      sessionId: SESSION_ID,
      method: "totp",
      code,
      action: ACTION,
    });
    expect(ok).toBe(false);
  });

  /** Section B (closed-beta remediation): disableMethod previously had no caller anywhere. */
  describe("disableMethod", () => {
    it("rejects disabling a method without a fresh step-up", async () => {
      const { secret } = await ctx.mfaService.beginTotpEnrollment(USER_ID, "user@example.com");
      await ctx.mfaService.confirmTotpEnrollment(USER_ID, computeTotpCode(secret));

      await expect(ctx.mfaService.disableMethod(USER_ID, SESSION_ID, "totp")).rejects.toThrow(
        "Step-up verification is required to disable two-factor authentication.",
      );
    });

    it("rejects disabling a method that isn't enrolled", async () => {
      const { secret } = await ctx.mfaService.beginTotpEnrollment(USER_ID, "user@example.com");
      const code = computeTotpCode(secret);
      await ctx.mfaService.confirmTotpEnrollment(USER_ID, code);
      await ctx.mfaService.completeStepUp({ userId: USER_ID, sessionId: SESSION_ID, method: "totp", code, action: "mfa_disable" });

      await expect(ctx.mfaService.disableMethod(USER_ID, SESSION_ID, "sms")).rejects.toThrow(
        "Text message is not an enrolled method for this account.",
      );
    });

    it("only disables the calling user's own credential for that method, never another user's", async () => {
      const OTHER_USER_ID = "user-2";
      const { secret } = await ctx.mfaService.beginTotpEnrollment(USER_ID, "user@example.com");
      const code = computeTotpCode(secret);
      await ctx.mfaService.confirmTotpEnrollment(USER_ID, code);
      const other = await ctx.mfaService.beginTotpEnrollment(OTHER_USER_ID, "other@example.com");
      await ctx.mfaService.confirmTotpEnrollment(OTHER_USER_ID, computeTotpCode(other.secret));
      await ctx.mfaService.completeStepUp({ userId: USER_ID, sessionId: SESSION_ID, method: "totp", code, action: "mfa_disable" });

      await ctx.mfaService.disableMethod(USER_ID, SESSION_ID, "totp");

      expect(await ctx.mfaService.hasVerifiedMethod(USER_ID)).toBe(false);
      expect(await ctx.mfaService.hasVerifiedMethod(OTHER_USER_ID)).toBe(true);
    });
  });
});
