import { beforeEach, describe, expect, it } from "vitest";
import { ConfigurationError, ForbiddenError, ValidationError } from "@/lib/errors";
import { FinancialIntegrityError } from "@/lib/ledger/ledgerService";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createTestPaymentService, createTestPaymentWebhookService } from "./testFakes";
import { classifyProcessingFailure, ProviderLookupEvidenceError } from "./paymentWebhookService";
import type { ProfileKind } from "./paymentProvider";

const PAYER_USER_ID = "payer-user-1";
const RECIPIENT_USER_ID = "recipient-user-1";
const REVIEWER_USER_ID = "reviewer-1";
const PAYER = { profileKind: "personal" as ProfileKind, profileId: "payer-profile-1" };
const RECIPIENT = { profileKind: "business" as ProfileKind, profileId: "recipient-profile-1" };

describe("PaymentWebhookService", () => {
  let paymentCtx: ReturnType<typeof createTestPaymentService>;
  let webhookCtx: ReturnType<typeof createTestPaymentWebhookService>;

  beforeEach(async () => {
    paymentCtx = createTestPaymentService();
    webhookCtx = createTestPaymentWebhookService(paymentCtx);
    paymentCtx.verificationCtx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
    paymentCtx.verificationCtx.profileOwners.set(RECIPIENT.profileKind, RECIPIENT.profileId, RECIPIENT_USER_ID);
    for (const ref of [PAYER, RECIPIENT]) {
      await paymentCtx.verificationCtx.verificationService.submitFullVerificationRequest(ref.profileKind, ref.profileId);
      await paymentCtx.verificationCtx.verificationService.recordManualVerificationDecision({
        actingRole: "platform_owner",
        profileKind: ref.profileKind,
        profileId: ref.profileId,
        decision: "verified",
        reviewerUserId: REVIEWER_USER_ID,
        reason: null,
      });
    }
  });

  // PACKAGE B — FINAL NARROW CORRECTION (Codex blocker A): every payment created via
  // PaymentService.createPayment now requires a non-null agreementId (submitToProvider rejects
  // otherwise) — an unregistered id, so the party cross-check this codebase's own convention already
  // skips for unregistered agreements remains unaffected.
  async function createPendingPayment(idempotencyKey: string) {
    return paymentCtx.paymentService.createPayment({
      idempotencyKey,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId: "test-agreement-default",
      actingUserId: PAYER_USER_ID,
      ipAddress: null,
      deviceInfo: null,
    });
  }

  function signedWebhook(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, signatureHeader: paymentCtx.provider.signWebhookPayload(rawBody) };
  }

  it("rejects a webhook with an invalid (spoofed) signature", async () => {
    const rawBody = JSON.stringify({ providerEventId: "evt_spoof", eventType: "payment.succeeded" });
    await expect(
      webhookCtx.paymentWebhookService.receiveWebhook({ rawBody, signatureHeader: "0".repeat(64) }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("transitions the matching payment on a valid payment.succeeded event", async () => {
    const record = await createPendingPayment("wh-1");
    const { rawBody, signatureHeader } = signedWebhook({
      providerEventId: "evt_1",
      eventType: "payment.succeeded",
      providerPaymentId: record.providerPaymentId,
    });
    const result = await webhookCtx.paymentWebhookService.receiveWebhook({ rawBody, signatureHeader });
    expect(result.status).toBe("processed");
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("succeeded");
  });

  it("PAID2YOU — B0-D ADYEN PHASE 1A (blocker 3 — cancel/refund finality): a payment.canceled event transitions a still-pending payment to canceled — newly webhook-reachable now that PaymentService.cancelPayment no longer finalizes synchronously", async () => {
    const record = await createPendingPayment("wh-cancel-1");
    const { rawBody, signatureHeader } = signedWebhook({
      providerEventId: "evt_cancel_1",
      eventType: "payment.canceled",
      providerPaymentId: record.providerPaymentId,
    });
    const result = await webhookCtx.paymentWebhookService.receiveWebhook({ rawBody, signatureHeader });
    expect(result.status).toBe("processed");
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("canceled");
  });

  it("PAID2YOU — B0-D ADYEN PHASE 1A (blocker 3): a payment.canceled event is a safe no-op with zero side effects — no ledger entry, no notification, no lifecycle recompute — matching a cancellation's own accurate lack of financial consequence", async () => {
    const record = await createPendingPayment("wh-cancel-2");
    const { rawBody, signatureHeader } = signedWebhook({
      providerEventId: "evt_cancel_2",
      eventType: "payment.canceled",
      providerPaymentId: record.providerPaymentId,
    });
    await webhookCtx.paymentWebhookService.receiveWebhook({ rawBody, signatureHeader });
    expect(await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id)).toHaveLength(0);
  });

  it("transitions succeeded -> refunded and succeeded -> disputed via their respective events", async () => {
    const record = await createPendingPayment("wh-2");
    const succeed = signedWebhook({ providerEventId: "evt_2a", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId });
    await webhookCtx.paymentWebhookService.receiveWebhook(succeed);

    const dispute = signedWebhook({ providerEventId: "evt_2b", eventType: "payment.disputed", providerPaymentId: record.providerPaymentId });
    await webhookCtx.paymentWebhookService.receiveWebhook(dispute);
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("disputed");
  });

  it("deduplicates a replayed event: second delivery is a no-op, reported as duplicate", async () => {
    const record = await createPendingPayment("wh-3");
    const event = signedWebhook({ providerEventId: "evt_3", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId });

    const first = await webhookCtx.paymentWebhookService.receiveWebhook(event);
    expect(first.status).toBe("processed");
    const second = await webhookCtx.paymentWebhookService.receiveWebhook(event);
    expect(second.status).toBe("duplicate");

    // Only one payment-status audit entry was recorded — the replay did not reapply the transition.
    expect(webhookCtx.auditRepo.events.filter((e) => e.action === "payment_webhook_payment.succeeded")).toHaveLength(1);
  });

  // R09 corrective pass (Codex blocker 3B): a RECOGNIZED financial event type with no matching
  // payment must remain unresolved/retryable — never silently "processed" (a real success could have
  // no ledger entry ever posted if this were treated as a safe no-op). "accepted" means durably
  // recorded and retryable, not lost.
  it("does not mark an event for an unknown provider payment id as processed — remains retryable", async () => {
    const { rawBody, signatureHeader } = signedWebhook({
      providerEventId: "evt_unknown",
      eventType: "payment.succeeded",
      providerPaymentId: "sandbox_pay_does_not_exist",
    });
    const result = await webhookCtx.paymentWebhookService.receiveWebhook({ rawBody, signatureHeader });
    expect(result.status).toBe("accepted");
    const eventRow = await webhookCtx.events.findByProviderEvent("sandbox_mock", "evt_unknown");
    expect(eventRow?.processingStatus).toBe("failed"); // retryable-failed, not permanently poisoned.
    expect(eventRow?.nextRetryAt).not.toBeNull();
  });

  // SPRINT_19_FraudRisk_SecurityHardening: previously applyEvent applied EVENT_TYPE_TO_STATUS
  // unconditionally regardless of the payment's current status. A stale/out-of-order webhook
  // (different event type, so the (provider, providerEventId) replay-dedup above never catches it)
  // arriving after a terminal status was already reached could regress it — e.g. a delayed
  // "payment.failed" landing after "payment.refunded" already posted would flip status back to
  // "failed" and re-run the failed-payment workflow against an already-refunded payment.
  it("ignores a stale out-of-order event that would regress an already-terminal payment status", async () => {
    const record = await createPendingPayment("wh-stale-1");
    const succeed = signedWebhook({ providerEventId: "evt_stale_1a", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId });
    await webhookCtx.paymentWebhookService.receiveWebhook(succeed);
    const refund = signedWebhook({ providerEventId: "evt_stale_1b", eventType: "payment.refunded", providerPaymentId: record.providerPaymentId });
    await webhookCtx.paymentWebhookService.receiveWebhook(refund);
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("refunded");

    // A delayed "payment.failed" for the same payment arrives after the refund already posted.
    const stale = signedWebhook({ providerEventId: "evt_stale_1c", eventType: "payment.failed", providerPaymentId: record.providerPaymentId });
    const result = await webhookCtx.paymentWebhookService.receiveWebhook(stale);
    expect(result.status).toBe("processed");
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("refunded");
    expect(webhookCtx.auditRepo.events.filter((e) => e.action === "payment_webhook_payment.failed")).toHaveLength(0);
  });

  // PAID2YOU — B0-D ADYEN PHASE 1B (item 1 — REFUNDED_REVERSED mapping)/1C (item 2 — ledger correction): required focused tests.
  it("REFUND -> REFUNDED_REVERSED: transitions to the distinct refund_reversed status, corrects the original refund's ledger effect exactly once, and never re-runs success effects", async () => {
    const record = await createPendingPayment("wh-reversed-1");
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_reversed_1a", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId }),
    );
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_reversed_1b", eventType: "payment.refunded", providerPaymentId: record.providerPaymentId }),
    );
    const entriesAfterRefund = await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id);
    const clearedEntry = entriesAfterRefund.find((e) => e.entryType === "payment_cleared")!;
    const refundEntry = entriesAfterRefund.find((e) => e.entryType === "refund")!;
    expect(clearedEntry).toBeDefined();
    expect(refundEntry).toBeDefined();

    const result = await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_reversed_1c", eventType: "payment.refund_reversed", providerPaymentId: record.providerPaymentId }),
    );
    expect(result.status).toBe("processed");
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("refund_reversed");

    // Exactly one new ledger entry — the correction — restoring the payment's cleared state exactly
    // once, never a second payment_cleared/refund and never a principal/fee duplication.
    const entriesAfterReversal = await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id);
    expect(entriesAfterReversal).toHaveLength(entriesAfterRefund.length + 1);
    const correctionEntries = entriesAfterReversal.filter((e) => e.entryType === "refund_correction");
    expect(correctionEntries).toHaveLength(1);

    // The correction's postings are the exact inverse of the refund's own postings — i.e. structurally
    // identical (account/direction/amount) to the ORIGINAL payment_cleared postings, ledger restored
    // exactly once, not merely a status flag.
    const correction = correctionEntries[0]!;
    const normalize = (postings: typeof correction.postings) =>
      [...postings].sort((a, b) => a.accountId.localeCompare(b.accountId)).map((p) => ({ accountId: p.accountId, direction: p.direction, amountMinorUnits: p.amountMinorUnits }));
    expect(normalize(correction.postings)).toEqual(normalize(clearedEntry.postings));

    // No duplicate success-effect audit entries — the original "succeeded" transition was recorded
    // exactly once, never re-triggered by the later reversal.
    expect(webhookCtx.auditRepo.events.filter((e) => e.action === "payment_webhook_payment.succeeded")).toHaveLength(1);
  });

  it("duplicate REFUNDED_REVERSED: a second, genuinely distinct payment.refund_reversed delivery for an already-reversed payment is ignored as a permanently illegal transition, and the exact same event redelivered is a plain dedup no-op", async () => {
    const record = await createPendingPayment("wh-reversed-2");
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_reversed_2a", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId }),
    );
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_reversed_2b", eventType: "payment.refunded", providerPaymentId: record.providerPaymentId }),
    );
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_reversed_2c", eventType: "payment.refund_reversed", providerPaymentId: record.providerPaymentId }),
    );
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("refund_reversed");

    // A second, distinct REFUNDED_REVERSED delivery (its own providerEventId, not a mere replay of the
    // first) finds the current status already "refund_reversed" — not a legal source for
    // "refund_reversed" (only "refunded" is, and "refund_reversed" itself has no legal outgoing
    // transition), so it is a genuinely dead, permanently-illegal transition: rejected, never reapplied.
    const entriesAfterFirst = await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id);
    expect(entriesAfterFirst.filter((e) => e.entryType === "refund_correction")).toHaveLength(1);

    const second = await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_reversed_2d", eventType: "payment.refund_reversed", providerPaymentId: record.providerPaymentId }),
    );
    expect(second.status).toBe("processed");
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("refund_reversed");
    expect(webhookCtx.auditRepo.events.filter((e) => e.action === "payment_webhook_payment.refund_reversed")).toHaveLength(1);

    // Zero duplicate financial effects: the illegal-transition dead end never reached the ledger a
    // second time — still exactly one correction entry.
    const entriesAfterSecond = await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id);
    expect(entriesAfterSecond).toHaveLength(entriesAfterFirst.length);
    expect(entriesAfterSecond.filter((e) => e.entryType === "refund_correction")).toHaveLength(1);

    // The exact same event redelivered (identical providerEventId) is caught by ordinary event-level dedup.
    const replay = await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_reversed_2c", eventType: "payment.refund_reversed", providerPaymentId: record.providerPaymentId }),
    );
    expect(replay.status).toBe("duplicate");

    // Belt-and-suspenders: the ledger's own idempotent get-or-post also refuses a direct second
    // correction attempt for the same payment, independent of the transition-matrix protection above.
    const directRetry = await webhookCtx.ledgerCtx.ledgerService.correctRefund({ paymentAttemptId: record.id, reason: null });
    expect(directRetry.id).toBe(entriesAfterFirst.find((e) => e.entryType === "refund_correction")!.id);
    expect(await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id)).toHaveLength(entriesAfterFirst.length);
  });

  it("out-of-order/replayed: a payment.refund_reversed arriving before any confirmed refund is durably retryable, never silently discarded or applied early — a payment that never reached refunded cannot yet be reversed", async () => {
    const record = await createPendingPayment("wh-reversed-3");
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_reversed_3a", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId }),
    );

    const outOfOrder = await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_reversed_3b", eventType: "payment.refund_reversed", providerPaymentId: record.providerPaymentId }),
    );
    // "succeeded" can still legally reach "refunded" (an allowed source for "refund_reversed") later —
    // this is a PROVISIONAL rejection, not a dead end: durably recorded/retryable ("accepted"), never a
    // silent no-op that could later let a legitimate reversal's effects go unapplied.
    expect(outOfOrder.status).toBe("accepted");
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("succeeded");
    expect(webhookCtx.auditRepo.events.filter((e) => e.action === "payment_webhook_payment.refund_reversed")).toHaveLength(0);

    // A real refund can still arrive afterward and finalize normally — the earlier out-of-order
    // delivery did not corrupt or block anything.
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_reversed_3c", eventType: "payment.refunded", providerPaymentId: record.providerPaymentId }),
    );
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("refunded");
  });

  // PAID2YOU — B0-D ADYEN PHASE 1C (item 1 — REFUND_FAILED): required focused tests.
  it("REFUND -> REFUND_FAILED: a payment.refund_failed event following a confirmed refund transitions to the distinct refund_failed status and corrects the refund's ledger effect exactly once", async () => {
    const record = await createPendingPayment("wh-refundfailed-1");
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_rf_1a", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId }),
    );
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_rf_1b", eventType: "payment.refunded", providerPaymentId: record.providerPaymentId }),
    );
    const entriesAfterRefund = await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id);
    const clearedEntry = entriesAfterRefund.find((e) => e.entryType === "payment_cleared")!;

    const result = await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_rf_1c", eventType: "payment.refund_failed", providerPaymentId: record.providerPaymentId }),
    );
    expect(result.status).toBe("processed");
    // Must not remain "refunded" — the refund is now known to have failed.
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("refund_failed");

    const entriesAfterFailure = await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id);
    expect(entriesAfterFailure).toHaveLength(entriesAfterRefund.length + 1);
    const correctionEntries = entriesAfterFailure.filter((e) => e.entryType === "refund_correction");
    expect(correctionEntries).toHaveLength(1);

    // Ledger restored exactly once — the correction's postings exactly mirror the original
    // payment_cleared postings (the money was never actually returned to the payer).
    const normalize = (postings: (typeof correctionEntries)[number]["postings"]) =>
      [...postings].sort((a, b) => a.accountId.localeCompare(b.accountId)).map((p) => ({ accountId: p.accountId, direction: p.direction, amountMinorUnits: p.amountMinorUnits }));
    expect(normalize(correctionEntries[0]!.postings)).toEqual(normalize(clearedEntry.postings));

    // No second payment-success effect, no duplicate lifecycle advancement.
    expect(webhookCtx.auditRepo.events.filter((e) => e.action === "payment_webhook_payment.succeeded")).toHaveLength(1);
  });

  it("duplicate REFUND_FAILED: a second, genuinely distinct payment.refund_failed delivery for an already-corrected payment is ignored as a permanently illegal transition, and the exact same event redelivered is a plain dedup no-op — zero duplicate financial effects either way", async () => {
    const record = await createPendingPayment("wh-refundfailed-2");
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_rf_2a", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId }),
    );
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_rf_2b", eventType: "payment.refunded", providerPaymentId: record.providerPaymentId }),
    );
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_rf_2c", eventType: "payment.refund_failed", providerPaymentId: record.providerPaymentId }),
    );
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("refund_failed");
    const entriesAfterFirst = await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id);
    expect(entriesAfterFirst.filter((e) => e.entryType === "refund_correction")).toHaveLength(1);

    // A second, distinct REFUND_FAILED delivery (its own providerEventId) finds the current status
    // already "refund_failed" — not a legal source for "refund_failed" (only "refunded" is, and
    // "refund_failed" itself has no legal outgoing transition) — a permanently-illegal dead end.
    const second = await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_rf_2d", eventType: "payment.refund_failed", providerPaymentId: record.providerPaymentId }),
    );
    expect(second.status).toBe("processed");
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("refund_failed");
    expect(webhookCtx.auditRepo.events.filter((e) => e.action === "payment_webhook_payment.refund_failed")).toHaveLength(1);

    const entriesAfterSecond = await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id);
    expect(entriesAfterSecond).toHaveLength(entriesAfterFirst.length);
    expect(entriesAfterSecond.filter((e) => e.entryType === "refund_correction")).toHaveLength(1);

    // The exact same event redelivered (identical providerEventId) is caught by ordinary event-level dedup.
    const replay = await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_rf_2c", eventType: "payment.refund_failed", providerPaymentId: record.providerPaymentId }),
    );
    expect(replay.status).toBe("duplicate");
  });

  it("out-of-order/replayed: a payment.refund_failed arriving before its own prerequisite REFUND has been confirmed is durably retryable, never silently discarded or applied early — and a genuinely-reversed (not failed) payment is correctly immune to a stale/misrouted REFUND_FAILED too", async () => {
    const record = await createPendingPayment("wh-refundfailed-3");
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_rf_3a", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId }),
    );

    // REFUND_FAILED delivered before the REFUND that must logically precede it (Adyen documents
    // REFUND_FAILED as only ever following an earlier REFUND success:true) — out-of-order redelivery.
    const outOfOrder = await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_rf_3b", eventType: "payment.refund_failed", providerPaymentId: record.providerPaymentId }),
    );
    // "succeeded" can still legally reach "refunded" (an allowed source for "refund_failed") later —
    // PROVISIONAL, not a dead end: durably retryable ("accepted"), never applied early / never corrupts
    // a ledger with nothing to correct yet.
    expect(outOfOrder.status).toBe("accepted");
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("succeeded");
    expect(webhookCtx.auditRepo.events.filter((e) => e.action === "payment_webhook_payment.refund_failed")).toHaveLength(0);
    expect(await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id)).toHaveLength(1); // only payment_cleared.

    // The real REFUND now arrives and finalizes normally — the earlier out-of-order delivery did not
    // corrupt or block anything.
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_rf_3c", eventType: "payment.refunded", providerPaymentId: record.providerPaymentId }),
    );
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("refunded");

    // REFUNDED_REVERSED applies first (the genuine outcome for this payment)...
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_rf_3d", eventType: "payment.refund_reversed", providerPaymentId: record.providerPaymentId }),
    );
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("refund_reversed");
    const entriesAfterReversal = await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id);
    expect(entriesAfterReversal.filter((e) => e.entryType === "refund_correction")).toHaveLength(1);

    // ...and a stale/misrouted REFUND_FAILED redelivery for the SAME payment, arriving after the fact,
    // is correctly rejected as a dead end — "refund_reversed" is not a legal source for "refund_failed"
    // either — never reapplying a second, conflicting correction.
    const stale = await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt_rf_3e", eventType: "payment.refund_failed", providerPaymentId: record.providerPaymentId }),
    );
    expect(stale.status).toBe("processed");
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("refund_reversed");
    expect(await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id)).toHaveLength(entriesAfterReversal.length);
  });

  // PAID2YOU — B0-D ADYEN PHASE 1B (item 2 — unknown processor fee): required focused tests for the
  // `postLedgerEntryRequired` `source: "provider_lookup"` evidence gate.
  it("accepts an explicit null processorFeeMinorUnits as valid provider_lookup evidence (a disclosed known-unknown) and posts the ledger entry without fabricating a numeric fee claim", async () => {
    const record = await createPendingPayment("wh-fee-unknown-1");
    const result = await webhookCtx.paymentWebhookService.receiveInternalEvent({
      provider: paymentCtx.provider.providerName,
      providerEventId: "internal-fee-unknown-1",
      eventType: "payment.succeeded",
      data: {
        providerPaymentId: record.providerPaymentId,
        amountMinorUnits: record.amountMinorUnits,
        currency: record.currency,
        processorFeeMinorUnits: null,
        platformFeeMinorUnits: 0,
      },
    });
    expect(result.status).toBe("processed");
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("succeeded");
    expect(await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id)).not.toHaveLength(0);
  });

  it("still rejects a genuinely missing/malformed processorFeeMinorUnits (undefined) as incomplete provider_lookup evidence — null is the only accepted known-unknown spelling, never mere absence", async () => {
    const record = await createPendingPayment("wh-fee-unknown-2");
    const result = await webhookCtx.paymentWebhookService.receiveInternalEvent({
      provider: paymentCtx.provider.providerName,
      providerEventId: "internal-fee-unknown-2",
      eventType: "payment.succeeded",
      data: {
        providerPaymentId: record.providerPaymentId,
        amountMinorUnits: record.amountMinorUnits,
        currency: record.currency,
        platformFeeMinorUnits: 0,
      },
    });
    // Durably retryable ("accepted"), never thrown to the caller (processAndFinalize) — and, critically,
    // the required ledger entry was never posted with a fabricated fee: the evidence gate refused it
    // outright rather than silently defaulting to $0.
    expect(result.status).toBe("accepted");
    expect(await webhookCtx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(record.id)).toHaveLength(0);
  });

  it("silently accepts (as processed) an event type it does not recognize", async () => {
    const record = await createPendingPayment("wh-4");
    const { rawBody, signatureHeader } = signedWebhook({
      providerEventId: "evt_unrecognized",
      eventType: "payment.something_new",
      providerPaymentId: record.providerPaymentId,
    });
    const result = await webhookCtx.paymentWebhookService.receiveWebhook({ rawBody, signatureHeader });
    expect(result.status).toBe("processed");
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("pending");
  });

  describe("notifications (Sprint 17 Product Owner review pass: payment_cleared/payment_disputed were templates/classifications with no real trigger anywhere in the codebase until this pass)", () => {
    it("notifies both parties on payment.succeeded (payment_cleared) and payment.disputed (payment_disputed)", async () => {
      const notifyCtx = createTestNotificationService();
      notifyCtx.contacts.set(PAYER_USER_ID, "payer@example.com");
      notifyCtx.contacts.set(RECIPIENT_USER_ID, "recipient@example.com");
      const wired = createTestPaymentWebhookService(
        paymentCtx,
        undefined,
        undefined,
        notifyCtx.notificationService,
        paymentCtx.verificationCtx.profileOwners,
      );

      const record = await createPendingPayment("wh-notify-1");
      await wired.paymentWebhookService.receiveWebhook(
        signedWebhook({ providerEventId: "evt_notify_1a", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId }),
      );
      expect(notifyCtx.emailSender.sent).toHaveLength(2); // both parties, payment_cleared

      const payerNotifications = await notifyCtx.notificationService.listForUser(PAYER_USER_ID);
      expect(payerNotifications.some((n) => n.notificationType === "payment_cleared")).toBe(true);

      await wired.paymentWebhookService.receiveWebhook(
        signedWebhook({ providerEventId: "evt_notify_1b", eventType: "payment.disputed", providerPaymentId: record.providerPaymentId }),
      );
      expect(notifyCtx.emailSender.sent).toHaveLength(4); // 2 more, payment_disputed (critical, both parties again)
      const payerNotificationsAfterDispute = await notifyCtx.notificationService.listForUser(PAYER_USER_ID);
      expect(payerNotificationsAfterDispute.some((n) => n.notificationType === "payment_disputed")).toBe(true);
    });

    it("does not fail the webhook if notification delivery is unavailable/unwired — notifications remain optional, matching failedPaymentWorkflow's identical precedent", async () => {
      // The shared beforeEach's webhookCtx was constructed without notifications/profileOwners at all.
      const record = await createPendingPayment("wh-notify-2");
      const result = await webhookCtx.paymentWebhookService.receiveWebhook(
        signedWebhook({ providerEventId: "evt_notify_2", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId }),
      );
      expect(result.status).toBe("processed");
      expect((await paymentCtx.payments.findById(record.id))?.status).toBe("succeeded");
    });
  });

  describe("SPRINT_19_FraudRisk_SecurityHardening: repeated-payment-failure risk signal", () => {
    it("records a risk signal for the payer on a failed transition", async () => {
      const wired = createTestPaymentWebhookService(paymentCtx, undefined, undefined, undefined, paymentCtx.verificationCtx.profileOwners);
      const record = await createPendingPayment("wh-risk-1");
      await wired.paymentWebhookService.receiveWebhook(
        signedWebhook({ providerEventId: "evt_risk_1", eventType: "payment.failed", providerPaymentId: record.providerPaymentId }),
      );
      const signals = wired.riskCtx.riskEvents.events.filter((e) => e.signalType === "repeated_payment_failure");
      expect(signals).toHaveLength(1);
      expect(signals[0]?.userId).toBe(PAYER_USER_ID);
      expect(signals[0]?.relatedResourceId).toBe(record.id);
    });

    it("does not record a signal on a non-failure transition", async () => {
      const wired = createTestPaymentWebhookService(paymentCtx, undefined, undefined, undefined, paymentCtx.verificationCtx.profileOwners);
      const record = await createPendingPayment("wh-risk-2");
      await wired.paymentWebhookService.receiveWebhook(
        signedWebhook({ providerEventId: "evt_risk_2", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId }),
      );
      expect(wired.riskCtx.riskEvents.events).toHaveLength(0);
    });

    it("never fails the webhook when profileOwners is not wired — riskEvents remains optional", async () => {
      // The shared beforeEach's webhookCtx was constructed without profileOwners at all.
      const record = await createPendingPayment("wh-risk-3");
      const result = await webhookCtx.paymentWebhookService.receiveWebhook(
        signedWebhook({ providerEventId: "evt_risk_3", eventType: "payment.failed", providerPaymentId: record.providerPaymentId }),
      );
      expect(result.status).toBe("processed");
    });
  });
});

describe("PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 4): ProviderLookupEvidenceError has its own EXPLICITLY-recognized error taxonomy entry", () => {
  it("classifies ProviderLookupEvidenceError as retryable/unresolved with its own distinct code — never the generic ValidationError code", () => {
    const result = classifyProcessingFailure(new ProviderLookupEvidenceError("payment_provider_lookup_incomplete_or_mismatched_amount"));
    expect(result.retryable).toBe(true);
    expect(result.code).toBe("provider_lookup_evidence_incomplete_or_invalid");
    expect(result.code).not.toBe("unresolved_financial_prerequisite"); // the generic ValidationError fallback code — must not be reached for this type.
  });

  it("is an instanceof ValidationError (codebase error-hierarchy consistency) but is checked BEFORE the generic ValidationError branch", () => {
    const error = new ProviderLookupEvidenceError("payment_provider_lookup_excessive_processor_fee");
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.name).toBe("ProviderLookupEvidenceError");
    expect(classifyProcessingFailure(error).code).toBe("provider_lookup_evidence_incomplete_or_invalid");
  });

  it("is never classified as FinancialIntegrityError (permanent/poison) — remains retryable even though it represents malformed financial evidence", () => {
    const result = classifyProcessingFailure(new ProviderLookupEvidenceError("payment_provider_lookup_invalid_combined_fees"));
    expect(result.retryable).toBe(true);
    expect(result.code).not.toBe("invalid_financial_data"); // FinancialIntegrityError's own code — reserved for genuinely impossible INTERNAL state.
  });

  it("regression: FinancialIntegrityError, ordinary ValidationError, and ConfigurationError keep their own EXISTING classification, unaffected by the new branch", () => {
    expect(classifyProcessingFailure(new FinancialIntegrityError("impossible"))).toEqual({ retryable: false, code: "invalid_financial_data" });
    expect(classifyProcessingFailure(new ValidationError("ordinary"))).toEqual({ retryable: true, code: "unresolved_financial_prerequisite" });
    expect(classifyProcessingFailure(new ConfigurationError("config"))).toEqual({ retryable: true, code: "repairable_configuration_defect" });
    expect(classifyProcessingFailure(new Error("transient"))).toEqual({ retryable: true, code: "transient_processing_error" });
  });
});
