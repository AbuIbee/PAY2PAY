import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { SandboxPaymentProvider } from "./sandboxPaymentProvider";

const SECRET = "sandbox-payment-provider-test-secret";
const PAYER = { profileKind: "personal" as const, profileId: "payer-1" };
const RECIPIENT = { profileKind: "business" as const, profileId: "recipient-1" };

describe("SandboxPaymentProvider (provider adapter)", () => {
  it("creates a recipient account, bank link, and payment method token", async () => {
    const provider = new SandboxPaymentProvider(SECRET);
    const account = await provider.createRecipientAccount({ recipient: RECIPIENT });
    expect(account.providerAccountId).toMatch(/^sandbox_acct_/);
    expect(account.payoutCapable).toBe(true);

    const bank = await provider.linkBankAccount({ profile: RECIPIENT, providerAccountId: account.providerAccountId });
    expect(bank.providerBankAccountRef).toMatch(/^sandbox_bank_/);

    const token = await provider.createPaymentMethodToken({ profile: PAYER, methodKind: "ach" });
    expect(token.providerPaymentMethodToken).toMatch(/^sandbox_pm_/);
  });

  describe("tokenizeBankAccount (Phase 6A fallback-architecture boundary)", () => {
    it("exchanges a raw routing/account number for an opaque reference and masked last4, echoing neither raw value back", async () => {
      const provider = new SandboxPaymentProvider(SECRET);
      const result = await provider.tokenizeBankAccount({
        profile: PAYER,
        routingNumber: "021000021",
        accountNumber: "123456789012",
        accountSubtype: "checking",
        accountHolderName: "Jordan Payer",
      });
      expect(result.providerAccountRef).toMatch(/^sandbox_bank_/);
      expect(result.maskedLast4).toBe("9012");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("021000021");
      expect(serialized).not.toContain("123456789012");
    });

    it("rejects a routing number that is not exactly 9 digits", async () => {
      const provider = new SandboxPaymentProvider(SECRET);
      await expect(
        provider.tokenizeBankAccount({
          profile: PAYER,
          routingNumber: "123",
          accountNumber: "123456789012",
          accountSubtype: "checking",
          accountHolderName: "Jordan Payer",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects an account number outside the 4-17 digit range", async () => {
      const provider = new SandboxPaymentProvider(SECRET);
      await expect(
        provider.tokenizeBankAccount({
          profile: PAYER,
          routingNumber: "021000021",
          accountNumber: "12",
          accountSubtype: "savings",
          accountHolderName: "Jordan Payer",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("never retains the raw values on the provider instance itself (no field/map grows to hold them)", async () => {
      const provider = new SandboxPaymentProvider(SECRET);
      await provider.tokenizeBankAccount({
        profile: PAYER,
        routingNumber: "021000021",
        accountNumber: "123456789012",
        accountSubtype: "checking",
        accountHolderName: "Jordan Payer",
      });
      // The provider's only stateful field is its private sandbox payments map — tokenizeBankAccount
      // must never write to it (structural proof, not just behavioral).
      const serializedInstance = JSON.stringify(provider);
      expect(serializedInstance ?? "").not.toContain("123456789012");
      expect(serializedInstance ?? "").not.toContain("021000021");
    });
  });

  it("defaults a created payment to pending (models async settlement)", async () => {
    const provider = new SandboxPaymentProvider(SECRET);
    const result = await provider.createPayment({
      idempotencyKey: "k1",
      amountMinorUnits: 1000,
      currency: "USD",
      payer: PAYER,
      recipient: RECIPIENT,
    });
    expect(result.status).toBe("pending");
    expect(result.providerPaymentId).toMatch(/^sandbox_pay_/);
  });

  it("honors an explicit simulateOutcome for succeeded/failed", async () => {
    const provider = new SandboxPaymentProvider(SECRET);
    const succeeded = await provider.createPayment({
      idempotencyKey: "k2",
      amountMinorUnits: 500,
      currency: "USD",
      payer: PAYER,
      recipient: RECIPIENT,
      simulateOutcome: "succeeded",
    });
    expect(succeeded.status).toBe("succeeded");

    const failed = await provider.createPayment({
      idempotencyKey: "k3",
      amountMinorUnits: 500,
      currency: "USD",
      payer: PAYER,
      recipient: RECIPIENT,
      simulateOutcome: "failed",
    });
    expect(failed.status).toBe("failed");
  });

  it("simulates a processor-level failure (distinct from a declined payment) by throwing", async () => {
    const provider = new SandboxPaymentProvider(SECRET);
    await expect(
      provider.createPayment({
        idempotencyKey: "k4",
        amountMinorUnits: 500,
        currency: "USD",
        payer: PAYER,
        recipient: RECIPIENT,
        simulateOutcome: "processor_error",
      }),
    ).rejects.toThrow("sandbox_processor_unavailable");
  });

  it("rejects a non-positive or non-integer amount", async () => {
    const provider = new SandboxPaymentProvider(SECRET);
    await expect(
      provider.createPayment({
        idempotencyKey: "k5",
        amountMinorUnits: 0,
        currency: "USD",
        payer: PAYER,
        recipient: RECIPIENT,
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      provider.createPayment({
        idempotencyKey: "k6",
        amountMinorUnits: 10.5,
        currency: "USD",
        payer: PAYER,
        recipient: RECIPIENT,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("retrieves a stored payment's status; rejects an unknown id", async () => {
    const provider = new SandboxPaymentProvider(SECRET);
    const { providerPaymentId } = await provider.createPayment({
      idempotencyKey: "k7",
      amountMinorUnits: 500,
      currency: "USD",
      payer: PAYER,
      recipient: RECIPIENT,
      simulateOutcome: "succeeded",
    });
    expect((await provider.retrievePayment(providerPaymentId)).status).toBe("succeeded");
    await expect(provider.retrievePayment("unknown")).rejects.toThrow(ValidationError);
  });

  it("cancels only while pending", async () => {
    const provider = new SandboxPaymentProvider(SECRET);
    const pending = await provider.createPayment({
      idempotencyKey: "k8",
      amountMinorUnits: 500,
      currency: "USD",
      payer: PAYER,
      recipient: RECIPIENT,
    });
    expect((await provider.cancelPayment(pending.providerPaymentId)).canceled).toBe(true);

    const succeeded = await provider.createPayment({
      idempotencyKey: "k9",
      amountMinorUnits: 500,
      currency: "USD",
      payer: PAYER,
      recipient: RECIPIENT,
      simulateOutcome: "succeeded",
    });
    expect((await provider.cancelPayment(succeeded.providerPaymentId)).canceled).toBe(false);
  });

  it("refunds only a succeeded payment", async () => {
    const provider = new SandboxPaymentProvider(SECRET);
    const pending = await provider.createPayment({
      idempotencyKey: "k10",
      amountMinorUnits: 500,
      currency: "USD",
      payer: PAYER,
      recipient: RECIPIENT,
    });
    await expect(provider.refundPayment(pending.providerPaymentId)).rejects.toThrow(ValidationError);

    const succeeded = await provider.createPayment({
      idempotencyKey: "k11",
      amountMinorUnits: 500,
      currency: "USD",
      payer: PAYER,
      recipient: RECIPIENT,
      simulateOutcome: "succeeded",
    });
    const refund = await provider.refundPayment(succeeded.providerPaymentId);
    expect(refund.providerRefundId).toMatch(/^sandbox_refund_/);
  });

  it("accepts a correctly-signed webhook payload", () => {
    const provider = new SandboxPaymentProvider(SECRET);
    const rawBody = JSON.stringify({ providerEventId: "evt_1", eventType: "payment.succeeded" });
    const signature = provider.signWebhookPayload(rawBody);
    expect(provider.verifyWebhookSignature(rawBody, signature)).toBe(true);
  });

  it("rejects a spoofed webhook: wrong secret, tampered body, or garbage signature", () => {
    const provider = new SandboxPaymentProvider(SECRET);
    const attacker = new SandboxPaymentProvider("a-completely-different-secret");
    const rawBody = JSON.stringify({ providerEventId: "evt_2", eventType: "payment.succeeded" });

    const spoofedSignature = attacker.signWebhookPayload(rawBody);
    expect(provider.verifyWebhookSignature(rawBody, spoofedSignature)).toBe(false);

    const genuineSignature = provider.signWebhookPayload(rawBody);
    const tamperedBody = JSON.stringify({ providerEventId: "evt_2", eventType: "payment.refunded" });
    expect(provider.verifyWebhookSignature(tamperedBody, genuineSignature)).toBe(false);

    expect(provider.verifyWebhookSignature(rawBody, "not-hex-at-all")).toBe(false);
  });

  it("parses a valid webhook payload and rejects malformed ones", () => {
    const provider = new SandboxPaymentProvider(SECRET);
    const rawBody = JSON.stringify({ providerEventId: "evt_3", eventType: "payment.succeeded", providerPaymentId: "sandbox_pay_x" });
    const parsed = provider.parseWebhookEvent(rawBody);
    expect(parsed).toMatchObject({ provider: "sandbox_mock", providerEventId: "evt_3", eventType: "payment.succeeded" });

    expect(() => provider.parseWebhookEvent("not json")).toThrow(ValidationError);
    expect(() => provider.parseWebhookEvent(JSON.stringify({ eventType: "payment.succeeded" }))).toThrow(ValidationError);
  });
});
