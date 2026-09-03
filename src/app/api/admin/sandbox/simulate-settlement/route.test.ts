import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestPaymentService } from "@/lib/payments/testFakes";
import { createTestPaymentWebhookService } from "@/lib/payments/testFakes";
import { SandboxPaymentProvider } from "@/lib/payments/sandboxPaymentProvider";
import type { PaymentProvider } from "@/lib/payments/paymentProvider";
import { createSimulateSettlementHandler } from "./route";

async function signupAs(authCtx: ReturnType<typeof createTestAuthService>, email: string, role: "member" | "platform_admin" | "platform_owner") {
  const user = await authCtx.authService.signup({
    accountType: "personal",
    identity: TEST_SIGNUP_IDENTITY,
    inviteCode: null,
    email,
    password: "a-strong-password",
    dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
    ipAddress: null,
    userAgent: null,
  });
  if (role !== "member") authCtx.users.setPlatformRole(user.user.id, role);
  return user;
}

/**
 * Restore agreement payment functionality: the sandbox-only, admin-gated route that drives a real,
 * webhook-verified settlement — the piece that makes "confirm the webhook/provider result updates
 * payment status" independently testable end-to-end without direct access to the raw
 * PAYMENT_SANDBOX_WEBHOOK_SECRET.
 */
describe("POST /api/admin/sandbox/simulate-settlement", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let paymentCtx: ReturnType<typeof createTestPaymentService>;
  let webhookCtx: ReturnType<typeof createTestPaymentWebhookService>;
  let sandboxProvider: SandboxPaymentProvider;

  beforeEach(() => {
    authCtx = createTestAuthService();
    paymentCtx = createTestPaymentService();
    sandboxProvider = paymentCtx.provider;
    webhookCtx = createTestPaymentWebhookService(paymentCtx);
  });

  function handler(provider: PaymentProvider = sandboxProvider) {
    return withErrorHandling(
      "admin_sandbox_simulate_settlement",
      createSimulateSettlementHandler(authCtx.authService, paymentCtx.payments, webhookCtx.paymentWebhookService, provider, sandboxProvider),
    );
  }

  function post(body: unknown, token?: string) {
    return new NextRequest("http://localhost/api/admin/sandbox/simulate-settlement", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(post({ paymentAttemptId: randomUUID(), outcome: "succeeded" }));
    expect(response.status).toBe(401);
  });

  it("rejects a non-admin member with 403", async () => {
    const member = await signupAs(authCtx, `sim-member-${randomUUID()}@example.com`, "member");
    const response = await handler()(post({ paymentAttemptId: randomUUID(), outcome: "succeeded" }, member.token));
    expect(response.status).toBe(403);
  });

  it("refuses when the configured provider is not the sandbox — structurally cannot touch a real processor", async () => {
    const admin = await signupAs(authCtx, `sim-admin-notsandbox-${randomUUID()}@example.com`, "platform_owner");
    const productionLikeProvider = { ...sandboxProvider, providerEnvironment: "production" as const } as unknown as PaymentProvider;
    const response = await handler(productionLikeProvider)(post({ paymentAttemptId: randomUUID(), outcome: "succeeded" }, admin.token));
    expect(response.status).toBe(500);
  });

  it("drives a genuine webhook-verified transition to succeeded, through the real PaymentWebhookService path", async () => {
    const admin = await signupAs(authCtx, `sim-admin-1-${randomUUID()}@example.com`, "platform_owner");
    const record = await paymentCtx.payments.insertPending({
      idempotencyKey: `sim-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: randomUUID(),
      recipientProfileKind: "personal",
      recipientProfileId: randomUUID(),
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId: null,
      providerName: sandboxProvider.providerName,
      initialStatus: "processing",
    });
    const providerResult = await sandboxProvider.createPayment({
      idempotencyKey: record.idempotencyKey,
      amountMinorUnits: 5_000,
      currency: "USD",
      payer: { profileKind: "personal", profileId: record.payerProfileId },
      recipient: { profileKind: "personal", profileId: record.recipientProfileId },
    });
    await paymentCtx.payments.updateStatus(record.id, "processing", { providerPaymentId: providerResult.providerPaymentId });

    const response = await handler()(post({ paymentAttemptId: record.id, outcome: "succeeded" }, admin.token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("processed");

    const updated = await paymentCtx.payments.findById(record.id);
    expect(updated?.status).toBe("succeeded");
  });

  it("drives a genuine webhook-verified transition to failed with the given failure category", async () => {
    const admin = await signupAs(authCtx, `sim-admin-2-${randomUUID()}@example.com`, "platform_owner");
    const record = await paymentCtx.payments.insertPending({
      idempotencyKey: `sim-fail-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: randomUUID(),
      recipientProfileKind: "personal",
      recipientProfileId: randomUUID(),
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId: null,
      providerName: sandboxProvider.providerName,
      initialStatus: "processing",
    });
    const providerResult = await sandboxProvider.createPayment({
      idempotencyKey: record.idempotencyKey,
      amountMinorUnits: 5_000,
      currency: "USD",
      payer: { profileKind: "personal", profileId: record.payerProfileId },
      recipient: { profileKind: "personal", profileId: record.recipientProfileId },
    });
    await paymentCtx.payments.updateStatus(record.id, "processing", { providerPaymentId: providerResult.providerPaymentId });

    const response = await handler()(post({ paymentAttemptId: record.id, outcome: "failed", failureCategory: "insufficient_funds" }, admin.token));
    expect(response.status).toBe(200);

    const updated = await paymentCtx.payments.findById(record.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.failureReason).toBe("insufficient_funds");
  });

  it("400s with a clear message when the payment attempt has no provider reference", async () => {
    const admin = await signupAs(authCtx, `sim-admin-3-${randomUUID()}@example.com`, "platform_owner");
    const record = await paymentCtx.payments.insertPending({
      idempotencyKey: `sim-noref-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: randomUUID(),
      recipientProfileKind: "personal",
      recipientProfileId: randomUUID(),
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId: null,
      providerName: sandboxProvider.providerName,
      initialStatus: "scheduled",
    });
    const response = await handler()(post({ paymentAttemptId: record.id, outcome: "succeeded" }, admin.token));
    expect(response.status).toBe(400);
  });
});
