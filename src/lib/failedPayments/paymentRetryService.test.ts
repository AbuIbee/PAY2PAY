import { randomUUID } from "node:crypto";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleQueryError } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestAchServices } from "@/lib/ach/testFakes";
import { createTestDebitCardServices, TEST_FUTURE_CARD_EXPIRY } from "@/lib/debitCard/testFakes";
import { createTestFailedPaymentWorkflow, InMemoryPaymentRetryRepository } from "./testFakes";
import { isFatalInfrastructureError, PaymentRetryService } from "./paymentRetryService";

const PAYER = { profileKind: "personal" as const, profileId: "payer-1" };
const RECIPIENT = { profileKind: "business" as const, profileId: "recipient-1" };
const PAYER_USER_ID = "payer-user-1";
const RECIPIENT_USER_ID = "recipient-user-1";
const REVIEWER_USER_ID = "reviewer-1";

describe("PaymentRetryService", () => {
  let ctx: ReturnType<typeof createTestFailedPaymentWorkflow>;
  const agreementId = randomUUID();
  const installmentId = randomUUID();

  beforeEach(async () => {
    // delayBusinessDays: 0 so a scheduled retry is immediately "due" for firing tests below.
    ctx = createTestFailedPaymentWorkflow(0);
    ctx.balanceCtx.terms.set(agreementId, 10_000, "USD");
    ctx.ach.paymentCtx.verificationCtx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
    ctx.ach.paymentCtx.verificationCtx.profileOwners.set(RECIPIENT.profileKind, RECIPIENT.profileId, RECIPIENT_USER_ID);
    ctx.notifyCtx.contacts.set(PAYER_USER_ID, "payer@example.com");
    ctx.notifyCtx.contacts.set(RECIPIENT_USER_ID, "recipient@example.com");
    for (const ref of [PAYER, RECIPIENT]) {
      await ctx.ach.paymentCtx.verificationCtx.verificationService.submitFullVerificationRequest(ref.profileKind, ref.profileId);
      await ctx.ach.paymentCtx.verificationCtx.verificationService.recordManualVerificationDecision({
        actingRole: "platform_owner",
        profileKind: ref.profileKind,
        profileId: ref.profileId,
        decision: "verified",
        reviewerUserId: REVIEWER_USER_ID,
        reason: null,
      });
    }
    await ctx.ach.achMandateService.authorize({ agreementId, payer: PAYER, bankAccountRef: "sandbox_bank_1", actingUserId: PAYER_USER_ID });
    ctx.installments.seed(installmentId, "2026-09-01");
  });

  function signedWebhook(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, signatureHeader: ctx.ach.paymentCtx.provider.signWebhookPayload(rawBody) };
  }

  async function failAnInstallmentPayment(idempotencyKey: string, amountMinorUnits = 5_000) {
    const scheduled = await ctx.ach.achPaymentService.scheduleInstallmentPayment({
      idempotencyKey,
      installmentScheduleItemId: installmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    const submitted = await ctx.ach.achPaymentService.submitScheduledPayment(scheduled.id, PAYER_USER_ID);
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({
        providerEventId: `evt-${idempotencyKey}`,
        eventType: "payment.failed",
        providerPaymentId: submitted.providerPaymentId,
        failureCategory: "insufficient_funds",
      }),
    );
    return submitted;
  }

  it("initial failure: marks the installment past_due, notifies both parties, and schedules exactly one retry", async () => {
    const submitted = await failAnInstallmentPayment("k-initial-fail");

    const failed = await ctx.ach.paymentCtx.payments.findById(submitted.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.failureReason).toBe("insufficient_funds"); // non-sensitive category actually captured (Sprint 13 fix)

    expect(ctx.installments.statusById.get(installmentId)).toBe("past_due");

    expect(ctx.notifyCtx.emailSender.sent).toHaveLength(2); // both parties
    expect(ctx.notifyCtx.emailSender.sent.every((m) => m.body.includes("insufficient_funds"))).toBe(true);

    const retry = await ctx.retries.findByOriginalPaymentAttemptId(submitted.id);
    expect(retry?.status).toBe("scheduled");
  });

  describe("findForOriginalPayment (Sprint 18B Payments UI)", () => {
    it("returns the scheduled retry to either party of the original payment", async () => {
      const submitted = await failAnInstallmentPayment("k-retry-status-payer");
      const asPayer = await ctx.paymentRetryService.findForOriginalPayment(submitted.id, PAYER_USER_ID);
      expect(asPayer?.status).toBe("scheduled");
      const asRecipient = await ctx.paymentRetryService.findForOriginalPayment(submitted.id, RECIPIENT_USER_ID);
      expect(asRecipient?.status).toBe("scheduled");
    });

    it("returns null for a user who is neither payer nor recipient", async () => {
      const submitted = await failAnInstallmentPayment("k-retry-status-stranger");
      const asStranger = await ctx.paymentRetryService.findForOriginalPayment(submitted.id, "stranger-user");
      expect(asStranger).toBeNull();
    });

    it("returns null when no retry was ever scheduled for this payment id", async () => {
      const result = await ctx.paymentRetryService.findForOriginalPayment(randomUUID(), PAYER_USER_ID);
      expect(result).toBeNull();
    });
  });

  it("retry: the scheduled retry fires and creates a new payment_attempt via the same payment method", async () => {
    const submitted = await failAnInstallmentPayment("k-retry-fires");
    const { fired, canceled } = await ctx.paymentRetryService.fireDueRetries(new Date(Date.now() + 1000));
    expect(fired).toBe(1);
    expect(canceled).toBe(0);

    const retry = await ctx.retries.findByOriginalPaymentAttemptId(submitted.id);
    expect(retry?.status).toBe("fired");
    expect(retry?.resultingPaymentAttemptId).toBeTruthy();

    const resulting = await ctx.ach.paymentCtx.payments.findById(retry!.resultingPaymentAttemptId!);
    expect(resulting?.paymentMethod).toBe("ach");
    expect(resulting?.amountMinorUnits).toBe(5_000);
  });

  it("manual success cancels retry: a manual payment succeeding for the same installment cancels the still-pending retry", async () => {
    const submitted = await failAnInstallmentPayment("k-manual-cancels");
    const scheduledRetry = await ctx.retries.findByOriginalPaymentAttemptId(submitted.id);
    expect(scheduledRetry?.status).toBe("scheduled");

    const manual = await ctx.ach.achPaymentService.createManualPayment({
      idempotencyKey: "k-manual-pay",
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
      installmentScheduleItemId: installmentId,
    });
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-manual-success", eventType: "payment.succeeded", providerPaymentId: manual.providerPaymentId }),
    );

    const canceledRetry = await ctx.retries.findByOriginalPaymentAttemptId(submitted.id);
    expect(canceledRetry?.status).toBe("canceled");
    expect(ctx.installments.statusById.get(installmentId)).toBe("paid");

    // The retry never fires after cancellation, even if the scheduler runs.
    const { fired } = await ctx.paymentRetryService.fireDueRetries(new Date(Date.now() + 1000));
    expect(fired).toBe(0);
  });

  it("retry failure: if the retry's own charge also fails, no second payment_retry row is ever created for it", async () => {
    const submitted = await failAnInstallmentPayment("k-retry-then-fails");
    await ctx.paymentRetryService.fireDueRetries(new Date(Date.now() + 1000));
    const retry = await ctx.retries.findByOriginalPaymentAttemptId(submitted.id);
    const resultingId = retry!.resultingPaymentAttemptId!;

    // The retry's own charge now fails too.
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({
        providerEventId: "evt-retry-fails",
        eventType: "payment.failed",
        providerPaymentId: (await ctx.ach.paymentCtx.payments.findById(resultingId))!.providerPaymentId,
        failureCategory: "card_declined",
      }),
    );

    // No NEW payment_retry row was created with the retry's own charge as *its* original attempt.
    expect(await ctx.retries.findByOriginalPaymentAttemptId(resultingId)).toBeNull();
    // Still exactly one payment_retry row total (the original), never a second.
    expect([...ctx.retries.byId.values()].length).toBe(1);
  });

  it("no third automatic retry: firing due retries twice in a row never creates a second payment_retry for the same original failure", async () => {
    const submitted = await failAnInstallmentPayment("k-no-third");
    await ctx.paymentRetryService.fireDueRetries(new Date(Date.now() + 1000));
    // A second scheduler run (e.g. the next cron tick) must not re-fire or duplicate anything.
    const second = await ctx.paymentRetryService.fireDueRetries(new Date(Date.now() + 2000));
    expect(second.fired).toBe(0);
    expect([...ctx.retries.byId.values()].filter((r) => r.originalPaymentAttemptId === submitted.id)).toHaveLength(1);
  });

  it("firing failure: a retry that fails to even initiate (e.g. mandate revoked) is marked canceled with the reason, not left to retry forever", async () => {
    const submitted = await failAnInstallmentPayment("k-firing-fails");
    const mandate = await ctx.ach.achMandateService.getActiveMandate(agreementId);
    await ctx.ach.achMandateService.revoke({ mandateId: mandate!.id, actingUserId: PAYER_USER_ID, reason: "borrower revoked" });

    const { fired, canceled } = await ctx.paymentRetryService.fireDueRetries(new Date(Date.now() + 1000));
    expect(fired).toBe(0);
    expect(canceled).toBe(1);
    const retry = await ctx.retries.findByOriginalPaymentAttemptId(submitted.id);
    expect(retry?.status).toBe("canceled");
    expect(retry?.canceledReason).toMatch(/Firing failed/);
  });

  it("routes by payment method: a debit-card original failure fires its retry through DebitCardPaymentService, not AchPaymentService", async () => {
    // Dedicated, self-contained context — the shared fixtures above are ACH-only. A separate,
    // wholly unused ACH context is wired in only to satisfy the initiators map's type, mirroring
    // testFakes.ts's own createTestFailedPaymentWorkflow pattern.
    const card = createTestDebitCardServices();
    const unusedAch = createTestAchServices();
    const retries = new InMemoryPaymentRetryRepository();
    const cardAgreementId = randomUUID();
    const cardInstallmentId = randomUUID();
    const cardPayer = { profileKind: "personal" as const, profileId: "card-payer-1" };
    const cardRecipient = { profileKind: "business" as const, profileId: "card-recipient-1" };
    const cardPayerUserId = "card-payer-user-1";
    const cardRecipientUserId = "card-recipient-user-1";

    card.paymentCtx.verificationCtx.profileOwners.set(cardPayer.profileKind, cardPayer.profileId, cardPayerUserId);
    card.paymentCtx.verificationCtx.profileOwners.set(cardRecipient.profileKind, cardRecipient.profileId, cardRecipientUserId);
    for (const ref of [cardPayer, cardRecipient]) {
      await card.paymentCtx.verificationCtx.verificationService.submitFullVerificationRequest(ref.profileKind, ref.profileId);
      await card.paymentCtx.verificationCtx.verificationService.recordManualVerificationDecision({
        actingRole: "platform_owner",
        profileKind: ref.profileKind,
        profileId: ref.profileId,
        decision: "verified",
        reviewerUserId: REVIEWER_USER_ID,
        reason: null,
      });
    }
    await card.debitCardMethodService.registerCard({
      agreementId: cardAgreementId,
      payer: cardPayer,
      cardToken: "sandbox_pm_1",
      cardLast4: "4242",
      cardBrand: "visa",
      ...TEST_FUTURE_CARD_EXPIRY,
      actingUserId: cardPayerUserId,
    });
    card.feeAllocation.set(cardAgreementId, "creditor_pays"); // no surcharge complexity needed for this test.

    const cardRetryService = new PaymentRetryService({
      retries,
      paymentAttempts: card.paymentCtx.payments,
      initiators: {
        ach: unusedAch.achPaymentService,
        debit_card: card.debitCardPaymentService,
        manual_off_platform: {
          createManualPayment: () => Promise.reject(new Error("not retryable")),
          prepareRetrySubmission: () => Promise.reject(new Error("not retryable")),
        },
      },
      profileOwners: card.paymentCtx.verificationCtx.profileOwners,
      audit: new AuditService(card.auditRepo),
      delayBusinessDays: 0,
    });

    const scheduled = await card.debitCardPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "k-card-fail",
      installmentScheduleItemId: cardInstallmentId,
      agreementId: cardAgreementId,
      payer: cardPayer,
      recipient: cardRecipient,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: cardPayerUserId,
    });
    const submitted = await card.debitCardPaymentService.submitScheduledPayment(scheduled.id, cardPayerUserId);
    // Directly exercises scheduling (not via a "payment.failed" webhook) — this test isolates the
    // initiator-routing logic only; scheduleRetryForFailedPayment itself never inspects `status`.
    const submittedRecord = await card.paymentCtx.payments.findById(submitted.id);
    await cardRetryService.scheduleRetryForFailedPayment(submittedRecord!);

    const { fired } = await cardRetryService.fireDueRetries(new Date(Date.now() + 1000));
    expect(fired).toBe(1);
    const retry = await retries.findByOriginalPaymentAttemptId(submitted.id);
    const resulting = await card.paymentCtx.payments.findById(retry!.resultingPaymentAttemptId!);
    expect(resulting?.paymentMethod).toBe("debit_card");
  });
});

describe("PAID2YOU — PACKAGE B (R06+R09 definitive implementation, Part XVIII): isFatalInfrastructureError determines DATABASE ORIGIN, not merely string shape", () => {
  /** Mirrors the exact wrapping shape drizzle-orm's pg-core session produces for every failed query (see that class's own doc comment) and the `postgres` driver's own `PostgresError` (name === "PostgresError", carrying the real SQLSTATE as `.code`). */
  function buildPostgresOriginError(sqlState: string): DrizzleQueryError {
    const cause = Object.assign(new Error(`simulated postgres error ${sqlState}`), { name: "PostgresError", code: sqlState });
    return new DrizzleQueryError("select 1", [], cause);
  }

  /** Mirrors postgres.js's own `connection()` error factory (node_modules/postgres/src/errors.js) — a raw transport/socket failure, never a `PostgresError` (the connection never reached far enough to get a server response at all). */
  function buildDbTransportError(code: string): DrizzleQueryError {
    const cause = Object.assign(new Error(`write ${code} 127.0.0.1:5432`), { code });
    return new DrizzleQueryError("select 1", [], cause);
  }

  it("R-B69A (invariant #61) — a real DrizzleQueryError whose cause is a genuine Postgres-origin connection-exception (SQLSTATE 08006) is fatal", () => {
    expect(isFatalInfrastructureError(buildPostgresOriginError("08006"))).toBe(true);
  });

  it("R-B69B (invariant #61) — a real DrizzleQueryError whose cause is a genuine Postgres-origin insufficient-resources error (SQLSTATE 53300) is fatal", () => {
    expect(isFatalInfrastructureError(buildPostgresOriginError("53300"))).toBe(true);
  });

  it("R-B69C (invariant #63) — an ordinary provider error whose own .code happens to collide with a SQLSTATE-shaped string, but is NOT of Drizzle/Postgres origin, is NOT database-fatal", () => {
    const providerError = Object.assign(new Error("simulated provider outage"), { code: "08006" });
    expect(isFatalInfrastructureError(providerError)).toBe(false);
  });

  it("R-B69D (invariant #64) — an ordinary provider timeout/network error (no .code at all, or an unrelated one, never wrapped by Drizzle) is NOT database-fatal", () => {
    expect(isFatalInfrastructureError(new Error("simulated provider request timeout"))).toBe(false);
    expect(isFatalInfrastructureError(Object.assign(new Error("simulated network error"), { code: "ETIMEDOUT" }))).toBe(false);
    expect(isFatalInfrastructureError(null)).toBe(false);
    expect(isFatalInfrastructureError(undefined)).toBe(false);
    expect(isFatalInfrastructureError("a plain string throw")).toBe(false);
  });

  it("R-B69E (invariant #62) — a Drizzle-wrapped DB-origin transport failure (ECONNRESET/ECONNREFUSED/ETIMEDOUT/EPIPE/ENETUNREACH/EHOSTUNREACH) IS database-fatal, even though it is never a PostgresError", () => {
    for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"]) {
      expect(isFatalInfrastructureError(buildDbTransportError(code))).toBe(true);
    }
  });

  it("R-B69F (invariant #63) — a PLAIN provider error carrying a transport-shaped code (ECONNRESET), never wrapped by Drizzle, is NOT database-fatal", () => {
    const plainProviderError = Object.assign(new Error("simulated provider connection reset"), { code: "ECONNRESET" });
    expect(isFatalInfrastructureError(plainProviderError)).toBe(false);
  });
});

describe("PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 5): isFatalInfrastructureError traverses the ENTIRE cause chain", () => {
  it("R-B70A — a direct Drizzle -> ECONNRESET (no intermediate wrapper) is database-fatal", () => {
    const cause = Object.assign(new Error("write ECONNRESET 127.0.0.1:5432"), { code: "ECONNRESET" });
    expect(isFatalInfrastructureError(new DrizzleQueryError("select 1", [], cause))).toBe(true);
  });

  it("R-B70B — a NESTED Drizzle -> wrapper -> ECONNRESET (two cause-links deep) is database-fatal", () => {
    const transportError = Object.assign(new Error("write ECONNRESET 127.0.0.1:5432"), { code: "ECONNRESET" });
    const wrapper = new Error("connection pool wrapper failure", { cause: transportError });
    expect(isFatalInfrastructureError(new DrizzleQueryError("select 1", [], wrapper))).toBe(true);
  });

  it("R-B70C — a direct Drizzle -> PostgresError (SQLSTATE 08006) is database-fatal", () => {
    const cause = Object.assign(new Error("simulated postgres error 08006"), { name: "PostgresError", code: "08006" });
    expect(isFatalInfrastructureError(new DrizzleQueryError("select 1", [], cause))).toBe(true);
  });

  it("R-B70D — a NESTED Drizzle -> wrapper -> PostgresError (SQLSTATE 53300, two cause-links deep) is database-fatal", () => {
    const postgresError = Object.assign(new Error("simulated postgres error 53300"), { name: "PostgresError", code: "53300" });
    const wrapper = new Error("connection pool wrapper failure", { cause: postgresError });
    expect(isFatalInfrastructureError(new DrizzleQueryError("select 1", [], wrapper))).toBe(true);
  });

  it("R-B70E — a plain provider ECONNRESET (never wrapped by Drizzle at any level) remains a provider failure, not database-fatal", () => {
    const plainProviderError = Object.assign(new Error("simulated provider connection reset"), { code: "ECONNRESET" });
    expect(isFatalInfrastructureError(plainProviderError)).toBe(false);
  });

  it("R-B70F — a plain provider error carrying SQLSTATE-shaped code 08006 (never wrapped by Drizzle, never a genuine PostgresError) remains a provider failure", () => {
    const plainProviderError = Object.assign(new Error("simulated provider outage"), { code: "08006" });
    expect(isFatalInfrastructureError(plainProviderError)).toBe(false);
  });

  it("R-B70G — a malformed/circular cause chain cannot loop indefinitely, and is never classified as fatal", () => {
    const nodeA: { message: string; cause?: unknown } = { message: "a" };
    const nodeB: { message: string; cause?: unknown } = { message: "b", cause: nodeA };
    nodeA.cause = nodeB; // a genuine 2-cycle.
    const start = Date.now();
    expect(isFatalInfrastructureError(new DrizzleQueryError("select 1", [], nodeA as unknown as Error))).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000); // terminates promptly — never hangs.

    // A direct self-reference (the tightest possible cycle) is equally safe.
    const selfReferential: { message: string; cause?: unknown } = { message: "self" };
    selfReferential.cause = selfReferential;
    expect(isFatalInfrastructureError(new DrizzleQueryError("select 1", [], selfReferential as unknown as Error))).toBe(false);
  });
});
