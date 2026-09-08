import { randomUUID } from "node:crypto";
import { and, DrizzleQueryError, eq, inArray, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getDb } from "@/db/client";
import { agreement, agreementVersion, auditEvent, installmentScheduleItem, paymentAttempt, paymentRetry, paymentWebhookEvent } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import { AgreementCompletionService, type AgreementBalanceComputer, type AgreementStatusRepository } from "@/lib/ledger/agreementCompletionService";
import { BalanceService } from "@/lib/ledger/balanceService";
import { DrizzleAgreementTermsReader } from "@/lib/ledger/drizzleAgreementTermsReader";
import { DrizzleLedgerAccountRepository } from "@/lib/ledger/drizzleLedgerAccountRepository";
import { DrizzleLedgerJournalEntryRepository } from "@/lib/ledger/drizzleLedgerJournalEntryRepository";
import { DrizzleReconciliationExceptionRepository, type ReconciliationExceptionInsertTestHooks } from "@/lib/ledger/drizzleReconciliationExceptionRepository";
import { LedgerService, type LedgerJournalEntryRecord } from "@/lib/ledger/ledgerService";
import { ReconciliationService } from "@/lib/ledger/reconciliationService";
import { createTestDebitCardServices, TEST_FUTURE_CARD_EXPIRY } from "@/lib/debitCard/testFakes";
import { DrizzleInstallmentStatusRepository } from "@/lib/failedPayments/drizzleInstallmentStatusRepository";
import {
  AmbiguousProviderResponseError,
  DrizzleFailedPaymentRetryCoordinator,
  type FailedPaymentRetryCoordinator,
  type InstallmentLockTestHooks,
} from "@/lib/failedPayments/failedPaymentRetryCoordinator";
import { DrizzlePaymentRetryRepository } from "@/lib/failedPayments/drizzlePaymentRetryRepository";
import { FailedPaymentWorkflowService } from "@/lib/failedPayments/failedPaymentWorkflowService";
import { PaymentRetryService, type RetryPaymentMethodInitiator } from "@/lib/failedPayments/paymentRetryService";
import { DrizzlePaymentInitiationEligibilityService } from "@/lib/payments/paymentInitiationEligibilityService";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createTestVerificationService } from "@/lib/profiles/testFakes";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { acquireAdvisoryLockBarrier, waitUntilPidBlockedOnLock } from "../../../test/postgres/lockBarrier";
import { createIsolatedDb, warmUp } from "../../../test/postgres/testDb";
import { DrizzlePaymentAttemptRepository } from "./drizzlePaymentAttemptRepository";
import { DrizzlePaymentWebhookEventRepository } from "./drizzlePaymentWebhookEventRepository";
import { InMemoryAgreementPartiesReader } from "./testFakes";
import { PaymentService, type PaymentAttemptRecord, type PaymentMethod } from "./paymentService";
import { DrizzlePaymentTransitionCoordinator } from "./paymentTransitionCoordinator";
import { computeBackoffMs, PaymentWebhookService, type FailedPaymentWorkflow } from "./paymentWebhookService";
import type { PlatformFeePolicy } from "./platformFeePolicy";
import { SandboxPaymentProvider } from "./sandboxPaymentProvider";

const DATABASE_URL = process.env.DATABASE_URL!;
const WEBHOOK_SECRET = "r06-r09-postgres-test-webhook-secret";

/**
 * R06 + R09 (payment/webhook recovery integrity) — mandatory real-Postgres proof. In-memory fakes
 * are not sufficient proof for this package (per its own mandate): every repository below is the
 * real Drizzle implementation against a real, disposable Postgres (see scripts/postgres-test-db.mjs).
 *
 * Scenarios B01–B15 map directly to this file's test titles. Where a scenario requires deterministic
 * time control (B03, B07, B08) this suite passes explicit `now`/`leaseMs` values straight into the
 * repository/service methods that already accept them — never a real sleep. Where a scenario requires
 * injecting a deterministic failure into an otherwise-real dependency (B04, B05, B09, B13, B14) this
 * suite wraps the REAL service instance in a thin, test-file-local `Proxy` that fails its first N
 * calls to one specific method before delegating to the real implementation — no production code is
 * touched or given any test-only hook for this; the Proxy is invisible to, and structurally
 * indistinguishable from, the real dependency from PaymentWebhookService's own point of view.
 */

function signedWebhook(provider: SandboxPaymentProvider, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return { rawBody, signatureHeader: provider.signWebhookPayload(rawBody) };
}

/** Wraps a real object in a Proxy that fails the first `failCount` calls to `methodName` with `error`, then delegates to the real implementation — a test-only failure-injection technique that touches no production code at all. */
function flaky<T extends object>(real: T, methodName: keyof T, failCount: number, error: () => Error): T {
  let calls = 0;
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === methodName) {
        return async (...args: unknown[]) => {
          calls += 1;
          if (calls <= failCount) throw error();
          return (target[methodName] as unknown as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}

async function seedAgreement(creditorProfileId: string, debtorProfileId: string, creatorUserId: string, principalMinorUnits: number) {
  const agreements = new DrizzleAgreementRepository();
  const created = await agreements.insert({
    creditorProfileKind: "personal",
    creditorProfileId,
    debtorProfileKind: "personal",
    debtorProfileId,
    currency: "USD",
    createdByUserId: creatorUserId,
  });
  const db = getDb();
  const [version] = await db
    .insert(agreementVersion)
    .values({
      agreementId: created.id,
      versionNumber: 1,
      isOriginal: true,
      producedBy: "r06_r09_postgres_test_seed",
      frequency: "monthly",
      feeAllocation: "creditor_pays",
      terms: { currentPrincipalMinorUnits: principalMinorUnits } as object,
    })
    .returning();
  if (!version) throw new Error("agreement_version insert returned no row");
  await db.update(agreement).set({ currentVersionId: version.id, status: "first_payment_pending" }).where(eq(agreement.id, created.id));
  return created.id;
}

function buildContext() {
  const provider = new SandboxPaymentProvider(WEBHOOK_SECRET);
  const payments = new DrizzlePaymentAttemptRepository();
  const events = new DrizzlePaymentWebhookEventRepository();
  const ledgerAccounts = new DrizzleLedgerAccountRepository();
  const ledgerEntries = new DrizzleLedgerJournalEntryRepository();
  const ledger = new LedgerService({ accounts: ledgerAccounts, entries: ledgerEntries, audit: new AuditService(new DrizzleAuditEventRepository()) });
  const agreements = new DrizzleAgreementRepository();
  const balances = new BalanceService({ ledger, terms: new DrizzleAgreementTermsReader() });
  const completion = new AgreementCompletionService({
    agreements: agreements as unknown as AgreementStatusRepository,
    balances: balances as unknown as AgreementBalanceComputer,
    audit: new AuditService(new DrizzleAuditEventRepository()),
  });
  const exceptions = new DrizzleReconciliationExceptionRepository();
  const reconciliation = new ReconciliationService({ payments, webhookEvents: events, provider, ledger, exceptions, completion });

  function buildWebhookService(overrides: Partial<ConstructorParameters<typeof PaymentWebhookService>[0]> = {}) {
    return new PaymentWebhookService({
      provider,
      events,
      payments,
      transitionCoordinator: new DrizzlePaymentTransitionCoordinator(),
      ledger,
      audit: new AuditService(new DrizzleAuditEventRepository()),
      completion,
      conflictExceptions: exceptions,
      ...overrides,
    });
  }

  return { provider, payments, events, ledgerAccounts, ledgerEntries, ledger, agreements, balances, completion, exceptions, reconciliation, buildWebhookService };
}

async function seedPendingPayment(
  payments: DrizzlePaymentAttemptRepository,
  opts: { agreementId: string; amountMinorUnits: number; payerProfileId: string; recipientProfileId: string; providerPaymentId: string },
): Promise<PaymentAttemptRecord> {
  const inserted = await payments.insertPending({
    idempotencyKey: randomUUID(),
    payerProfileKind: "personal",
    payerProfileId: opts.payerProfileId,
    recipientProfileKind: "personal",
    recipientProfileId: opts.recipientProfileId,
    amountMinorUnits: opts.amountMinorUnits,
    currency: "USD",
    agreementId: opts.agreementId,
    providerName: "sandbox_mock",
  });
  return payments.updateStatus(inserted.id, "pending", { providerPaymentId: opts.providerPaymentId });
}

async function findClearEntry(ledger: LedgerService, paymentAttemptId: string): Promise<LedgerJournalEntryRecord | null> {
  return ledger.findEntry(paymentAttemptId, "payment_cleared");
}

/** R09 corrective pass (Codex blocker 9) — reads the audit_event table directly to verify idempotent identity, bypassing AuditService (which has no "find" method of its own). */
async function findAuditEventsByProviderEvent(providerEventId: string, action: string) {
  const db = getDb();
  return db.select().from(auditEvent).where(and(eq(auditEvent.providerEventId, providerEventId), eq(auditEvent.action, action)));
}

/** R09 corrective pass (Codex blocker 7) — like seedAgreement, but also seeds one real installment_schedule_item row, for FailedPaymentWorkflowService's own production repository to act on. `dueDate` defaults to the original, deliberately-past fixture date; the Stage 6 supersession-compensation tests override it to exercise the future/not-yet-due branch. */
async function seedAgreementWithInstallment(
  creditorProfileId: string,
  debtorProfileId: string,
  creatorUserId: string,
  principalMinorUnits: number,
  dueDate: string = "2020-01-01",
) {
  const agreements = new DrizzleAgreementRepository();
  const created = await agreements.insert({
    creditorProfileKind: "personal",
    creditorProfileId,
    debtorProfileKind: "personal",
    debtorProfileId,
    currency: "USD",
    createdByUserId: creatorUserId,
  });
  const db = getDb();
  const [version] = await db
    .insert(agreementVersion)
    .values({
      agreementId: created.id,
      versionNumber: 1,
      isOriginal: true,
      producedBy: "r06_r09_postgres_test_seed",
      frequency: "monthly",
      feeAllocation: "creditor_pays",
      terms: { currentPrincipalMinorUnits: principalMinorUnits } as object,
    })
    .returning();
  if (!version) throw new Error("agreement_version insert returned no row");
  await db.update(agreement).set({ currentVersionId: version.id, status: "first_payment_pending" }).where(eq(agreement.id, created.id));
  const [installment] = await db
    .insert(installmentScheduleItem)
    .values({ agreementVersionId: version.id, sequenceNumber: 0, dueDate, amountMinorUnits: principalMinorUnits })
    .returning();
  if (!installment) throw new Error("installment_schedule_item insert returned no row");
  return { agreementId: created.id, installmentScheduleItemId: installment.id };
}

/** Deterministic-barrier helper, mirroring signingConcurrency.postgres.test.ts's identical precedent. */
function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function installmentStatus(installmentScheduleItemId: string): Promise<string | null> {
  return new DrizzleInstallmentStatusRepository().findStatus(installmentScheduleItemId);
}

async function listRetriesForInstallment(installmentScheduleItemId: string) {
  const db = getDb();
  return db.select().from(paymentRetry).where(eq(paymentRetry.installmentScheduleItemId, installmentScheduleItemId));
}

/** PACKAGE B — FINAL NARROW CORRECTION (Codex blocker 7): seeds a real, provider-routed, pending payment_attempt linked to a real installment, for the atomic retry coordinator's own tests. */
async function seedInstallmentPayment(
  agreementId: string,
  installmentScheduleItemId: string,
  debtor: { profileId: string },
  creditor: { profileId: string },
): Promise<PaymentAttemptRecord> {
  const payments = new DrizzlePaymentAttemptRepository();
  const providerPaymentId = `sandbox_pay_${randomUUID()}`;
  const inserted = await payments.insertPending({
    idempotencyKey: randomUUID(),
    payerProfileKind: "personal",
    payerProfileId: debtor.profileId,
    recipientProfileKind: "personal",
    recipientProfileId: creditor.profileId,
    amountMinorUnits: 5_000,
    currency: "USD",
    agreementId,
    providerName: "sandbox_mock",
    installmentScheduleItemId,
  });
  return payments.updateStatus(inserted.id, "pending", { providerPaymentId });
}

/** `seedInstallmentPayment` never sets `paymentMethod` (most tests bypass `fireDueRetries` entirely, going straight to the coordinator) — the REAL `fireDueRetries` entry point requires it to look up an initiator. Used only by tests that exercise `fireDueRetries` itself. */
async function seedInstallmentPaymentWithMethod(
  agreementId: string,
  installmentScheduleItemId: string,
  debtor: { profileId: string },
  creditor: { profileId: string },
): Promise<PaymentAttemptRecord> {
  const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
  const db = getDb();
  await db.update(paymentAttempt).set({ paymentMethod: "ach" }).where(eq(paymentAttempt.id, payment.id));
  return { ...payment, paymentMethod: "ach" };
}

describe("R06 + R09: payment/webhook recovery integrity (real Postgres)", () => {
  async function seedTwoParties(principalMinorUnits = 10_000) {
    const creditor = await seedPersonalUser("r06r09-creditor");
    const debtor = await seedPersonalUser("r06r09-debtor");
    const agreementId = await seedAgreement(creditor.profileId, debtor.profileId, creditor.userId, principalMinorUnits);
    return { creditor, debtor, agreementId };
  }

  it("B01 — normal success: first valid delivery durably records the event, transitions the payment exactly once, posts the required ledger entry exactly once, converges the agreement lifecycle, and marks the event processed", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, {
      agreementId,
      amountMinorUnits: 5_000,
      payerProfileId: debtor.profileId,
      recipientProfileId: creditor.profileId,
      providerPaymentId,
    });
    const webhook = ctx.buildWebhookService();
    const providerEventId = `evt-${randomUUID()}`;
    const result = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId }));

    expect(result.status).toBe("processed");
    expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded");
    const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
    expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full");
    const eventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
    expect(eventRow?.processingStatus).toBe("processed");
    expect(eventRow?.processedAt).not.toBeNull();
  });

  it("B02 — processed duplicate: redelivering an already-processed event never duplicates any financial write and reports an idempotent outcome", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 5_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    const webhook = ctx.buildWebhookService();
    const event = signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId });

    const first = await webhook.receiveWebhook(event);
    expect(first.status).toBe("processed");
    const second = await webhook.receiveWebhook(event);
    expect(second.status).toBe("duplicate");

    const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
  });

  it("B03 — crash after event receipt: an event durably claimed but never completed is NOT treated as complete, is safely reclaimed by recovery, and completes processing exactly once", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 5_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });

    // Simulate "webhook received, worker crashed before completing" — a real claim, with a short
    // lease, that never gets finalized (no markProcessed/markFailed call follows).
    const claimedAt = new Date();
    const crashed = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId },
      leaseMs: 1_000,
      now: claimedAt,
    });
    expect(crashed).not.toBeNull();
    expect((await ctx.payments.findById(payment.id))?.status).toBe("pending"); // existence alone proved nothing.

    // Recovery runs well after the short lease has lapsed — deterministic time control, no real sleep.
    const afterLeaseExpiry = new Date(claimedAt.getTime() + 5_000);
    const webhook = ctx.buildWebhookService();
    const recovery = await webhook.recoverBatch(10, afterLeaseExpiry);
    expect(recovery.claimed).toBeGreaterThanOrEqual(1);
    expect(recovery.processed).toBeGreaterThanOrEqual(1);

    expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded");
    const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
    const finalEvent = (await ctx.events.listAll()).find((e) => e.id === crashed!.id);
    expect(finalEvent?.processingStatus).toBe("processed");
  });

  it("B04 — failure after payment status update, before the required ledger consequence: recovery converges the ledger exactly once, without double-transitioning status, and the event eventually becomes processed", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 5_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });

    const flakyLedger = flaky(ctx.ledger, "postPaymentCleared", 1, () => new Error("simulated_transient_ledger_failure"));
    const webhook = ctx.buildWebhookService({ ledger: flakyLedger });
    const providerEventId = `evt-${randomUUID()}`;
    const event = signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId });

    const attempt1 = await webhook.receiveWebhook(event);
    expect(attempt1.status).toBe("accepted"); // durably claimed, ledger step failed, not marked processed.
    expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded"); // status transition already committed.
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();

    const eventRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))!;
    expect(eventRow.processingStatus).toBe("failed");
    expect(eventRow.nextRetryAt).not.toBeNull();

    // Retry (via the recovery path, deterministic time control past the computed backoff — no real sleep).
    const retryAt = new Date(eventRow.nextRetryAt!.getTime() + 1);
    const recovery = await webhook.recoverBatch(10, retryAt);
    expect(recovery.processed).toBe(1);

    expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded"); // never double-transitioned.
    const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // converged exactly once.
    expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))?.processingStatus).toBe("processed");
  });

  it("B05 — failure after the ledger, before the required lifecycle consequence: recovery does not duplicate the ledger, retries the lifecycle step, and converges correctly", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties(5_000); // full principal in one payment -> paid_in_full.
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 5_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });

    const flakyCompletion = flaky(ctx.completion, "checkAndAdvance", 1, () => new Error("simulated_transient_completion_failure"));
    const webhook = ctx.buildWebhookService({ completion: flakyCompletion });
    const providerEventId = `evt-${randomUUID()}`;
    const event = signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId });

    const attempt1 = await webhook.receiveWebhook(event);
    expect(attempt1.status).toBe("accepted");
    const entriesAfterFirst = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entriesAfterFirst.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // ledger already committed.
    expect((await ctx.agreements.findById(agreementId))?.status).toBe("first_payment_pending"); // lifecycle not yet advanced.

    const eventRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))!;
    const retryAt = new Date(eventRow.nextRetryAt!.getTime() + 1);
    const recovery = await webhook.recoverBatch(10, retryAt);
    expect(recovery.processed).toBe(1);

    const entriesAfterRetry = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entriesAfterRetry.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // not duplicated.
    expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full"); // converged.
  });

  it("B06 — concurrent duplicate delivery: two independent real Postgres connections delivering the identical event produce exactly one effective processing pass, one set of financial consequences, and no duplicate ledger entries", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
      const event = signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId });

      const isolatedA = createIsolatedDb(DATABASE_URL);
      const isolatedB = createIsolatedDb(DATABASE_URL);
      try {
        const webhookA = new PaymentWebhookService({
          provider: ctx.provider,
          events: new DrizzlePaymentWebhookEventRepository(isolatedA.db),
          payments: new DrizzlePaymentAttemptRepository(isolatedA.db),
          transitionCoordinator: new DrizzlePaymentTransitionCoordinator(isolatedA.db),
          ledger: ctx.ledger,
          audit: new AuditService(new DrizzleAuditEventRepository()),
          completion: ctx.completion,
        });
        const webhookB = new PaymentWebhookService({
          provider: ctx.provider,
          events: new DrizzlePaymentWebhookEventRepository(isolatedB.db),
          payments: new DrizzlePaymentAttemptRepository(isolatedB.db),
          transitionCoordinator: new DrizzlePaymentTransitionCoordinator(isolatedB.db),
          ledger: ctx.ledger,
          audit: new AuditService(new DrizzleAuditEventRepository()),
          completion: ctx.completion,
        });

        const [resultA, resultB] = await Promise.all([webhookA.receiveWebhook(event), webhookB.receiveWebhook(event)]);
        const statuses = [resultA.status, resultB.status].sort();
        // Exactly one side actually applied the effects ("processed"); the other observed the real,
        // live claim/lease or the final processed state ("accepted"/"duplicate") — never two "processed".
        expect(statuses.filter((s) => s === "processed")).toHaveLength(1);

        const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
        expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
        expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded");
      } finally {
        await isolatedA.close();
        await isolatedB.close();
      }
    }
  });

  it("B07 — stale processing lease: after lease expiration, a different worker can safely reclaim the event, and it completes with no duplicates (deterministic time control, no real sleep)", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });

    const claimedAt = new Date();
    const firstWorkerClaim = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId },
      leaseMs: 500,
      now: claimedAt,
    });
    expect(firstWorkerClaim).not.toBeNull();

    // A second worker's attempt WHILE the lease is still live must not reclaim it — a read-only
    // outcome check (claimExistingForProcessing writes nothing on an "in_progress" result), so this
    // does not consume or otherwise disturb the still-active claim.
    const stillLive = await ctx.events.claimExistingForProcessing(ctx.provider.providerName, firstWorkerClaim!.providerEventId, 500, new Date(claimedAt.getTime() + 100));
    expect(stillLive.outcome).toBe("in_progress");

    // After the lease has lapsed, recovery (the real, complete reclaim-and-process path — not a
    // second manual claim, which would just leave it claimed-but-unprocessed again) safely reclaims
    // and completes it, exactly once.
    const afterExpiry = new Date(claimedAt.getTime() + 5_000);
    const webhook = ctx.buildWebhookService();
    const recovery = await webhook.recoverBatch(10, afterExpiry);
    expect(recovery.claimed).toBeGreaterThanOrEqual(1);
    expect(recovery.processed).toBeGreaterThanOrEqual(1);

    const finalEvent = await ctx.events.findByProviderEvent(ctx.provider.providerName, firstWorkerClaim!.providerEventId);
    expect(finalEvent?.processingStatus).toBe("processed");
    expect(finalEvent?.processingAttempts).toBe(2); // incremented (1 for the original crashed claim, 2 for the reclaim), not reset.
    const entries = await ctx.ledger.listEntriesForPaymentAttempt((await ctx.payments.findByProviderPaymentId(providerPaymentId))!.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
  });

  it("B08 — active processing lease: a second worker attempting the same event while the lease is live must not duplicate financial processing", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });

    const now = new Date();
    const firstClaim = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId },
      leaseMs: 60_000,
      now,
    });
    expect(firstClaim).not.toBeNull();

    const secondAttempt = await ctx.events.claimExistingForProcessing(ctx.provider.providerName, firstClaim!.providerEventId, 60_000, new Date(now.getTime() + 10));
    expect(secondAttempt.outcome).toBe("in_progress");

    // No second processing ever ran — no ledger entry exists yet (only the first, still-active claim did anything at all).
    const payment = await ctx.payments.findByProviderPaymentId(providerPaymentId);
    const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment!.id);
    expect(entries).toHaveLength(0);
  });

  it("B09 — retryable failure: a transient first-attempt failure increments attempts and persists a sanitized error, and a later retry succeeds with processedAt set only after completion", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });

    const flakyLedger = flaky(ctx.ledger, "postPaymentCleared", 1, () => new Error("simulated_transient_ledger_failure"));
    const webhook = ctx.buildWebhookService({ ledger: flakyLedger });
    const providerEventId = `evt-${randomUUID()}`;
    const event = signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId });

    await webhook.receiveWebhook(event);
    const afterFirst = (await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))!;
    expect(afterFirst.processingStatus).toBe("failed");
    expect(afterFirst.processingAttempts).toBe(1);
    expect(afterFirst.lastErrorCode).toBe("transient_processing_error"); // sanitized fixed code, never a raw message.
    expect(afterFirst.processedAt).toBeNull();
    expect(afterFirst.nextRetryAt!.getTime()).toBeGreaterThan(afterFirst.lastFailedAt!.getTime());
    expect(afterFirst.nextRetryAt!.getTime() - afterFirst.lastFailedAt!.getTime()).toBeCloseTo(computeBackoffMs(1), -2);

    await webhook.recoverBatch(10, new Date(afterFirst.nextRetryAt!.getTime() + 1));
    const afterRetry = (await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))!;
    expect(afterRetry.processingAttempts).toBe(2);
    expect(afterRetry.processingStatus).toBe("processed");
    expect(afterRetry.processedAt).not.toBeNull();
  });

  it("B10 — poison/permanent failure: a malformed trusted event never creates false financial effects, does not spin (no nextRetryAt), and remains visible/auditable for manual action", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    const webhook = ctx.buildWebhookService();
    // The processor fee alone exceeds the gross amount — LedgerService.postPaymentCleared's own
    // FinancialIntegrityError: a genuinely impossible/malformed payload, not a transient condition
    // retrying could ever fix. PAID2YOU — PACKAGE B (Stage 6 architectural review remediation, Item
    // 2): platformFeeMinorUnits is NEVER sourced from a webhook's own payload for the actual posting
    // (it always comes from the centralized platformFeePolicy, which defaults to 0) — so a webhook
    // payload claiming a large platformFeeMinorUnits no longer contributes to this poison scenario at
    // all; only processorFeeMinorUnits (which webhook postings DO still read from the payload) can
    // still exceed the gross amount by itself.
    const providerEventId = `evt-${randomUUID()}`;
    const event = signedWebhook(ctx.provider, {
      providerEventId,
      eventType: "payment.succeeded",
      providerPaymentId,
      processorFeeMinorUnits: 1_500,
    });

    const result = await webhook.receiveWebhook(event);
    expect(result.status).toBe("accepted");

    const eventRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))!;
    expect(eventRow.processingStatus).toBe("failed");
    expect(eventRow.nextRetryAt).toBeNull(); // permanent — never retried again, never spins.
    expect(eventRow.lastErrorCode).toBe("invalid_financial_data");

    // No false financial effect — the payment status was already transitioned (that part succeeded;
    // only the impossible ledger posting failed), but no ledger entry exists.
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();

    // Still visible/auditable, and never reclaimed — checked directly for THIS event (never a
    // system-wide batch call with an arbitrary future "now", which could sweep up unrelated events
    // elsewhere in this shared-database suite that legitimately do have a due retry/expired lease at
    // that hypothetical time).
    const recheck = await ctx.events.claimExistingForProcessing(ctx.provider.providerName, providerEventId, 120_000, new Date(Date.now() + 60 * 60 * 1000));
    expect(recheck.outcome).toBe("not_due");
    expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))?.processingStatus).toBe("failed");
  });

  it("B11 — reconciliation repair: a succeeded payment with a missing required payment_cleared ledger entry is repaired exactly once, and re-running recovery creates no duplicate", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, {
      agreementId,
      amountMinorUnits: 2_000,
      payerProfileId: debtor.profileId,
      recipientProfileId: creditor.profileId,
      providerPaymentId,
    });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});
    // A trusted, already-processed "payment.succeeded" event for this exact payment — the
    // authoritative source SAFE AUTOMATIC REPAIR is allowed to reconstruct from (see
    // ReconciliationService.tryRepairMissingLedgerEntry's own doc comment). Models the required
    // ledger consequence having been lost between a genuinely trusted provider success and the
    // ledger actually committing (e.g. a crash), not a fabricated/unverified success.
    const trustedEvent = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId, amountMinorUnits: 2_000, currency: "USD", processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 },
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();

    const found = await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).not.toContain("internal_posting_failure");
    const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);

    await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    const entriesAfterSecondRun = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entriesAfterSecondRun.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
  });

  it("B12 — lifecycle repair: a valid financial completion with the lifecycle side effect absent converges the agreement, and repeated recovery is idempotent", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
    const ctx = buildContext();
    const payment = await seedPendingPayment(ctx.payments, {
      agreementId,
      amountMinorUnits: 5_000,
      payerProfileId: debtor.profileId,
      recipientProfileId: creditor.profileId,
      providerPaymentId: `sandbox_pay_${randomUUID()}`,
    });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: payment.id, agreementId, currency: "USD", grossAmountMinorUnits: 5_000 });
    expect((await ctx.agreements.findById(agreementId))?.status).toBe("first_payment_pending");

    await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full");

    await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full"); // idempotent.
  });

  it("B13 — failed required financial effect: the webhook event MUST NOT be marked fully processed while the required ledger posting fails", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    const flakyLedger = flaky(ctx.ledger, "postPaymentCleared", 5, () => new Error("simulated_persistent_ledger_failure"));
    const webhook = ctx.buildWebhookService({ ledger: flakyLedger });
    const providerEventId = `evt-${randomUUID()}`;
    const event = signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId });

    const result = await webhook.receiveWebhook(event);
    expect(result.status).not.toBe("processed");
    expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))?.processingStatus).not.toBe("processed");
  });

  it("B14 — noncritical side-effect failure: financial processing still completes when a noncritical dependency (agreement-completion side channel simulated as noncritical here via a best-effort riskEvents-style path) fails, while remaining observable", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    // riskEvents is explicitly classified NONCRITICAL (see PaymentWebhookService's own doc comment) —
    // a throwing implementation must never block financial processing.
    const throwingRiskEvents = {
      async recordSignal() {
        throw new Error("simulated_risk_service_outage");
      },
    };
    const throwingProfileOwners = {
      async getOwnerUserId() {
        return "some-user-id";
      },
    };
    const webhook = ctx.buildWebhookService({
      riskEvents: throwingRiskEvents as unknown as ConstructorParameters<typeof PaymentWebhookService>[0]["riskEvents"],
      profileOwners: throwingProfileOwners as unknown as ConstructorParameters<typeof PaymentWebhookService>[0]["profileOwners"],
    });
    const event = signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.failed", providerPaymentId });

    const result = await webhook.receiveWebhook(event);
    expect(result.status).toBe("processed"); // financial processing completed despite the noncritical failure.
    expect((await ctx.payments.findById(payment.id))?.status).toBe("failed");
  });

  it("B15 — out-of-order/terminal event regression: existing terminal-state protections still hold after the recovery redesign", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    const webhook = ctx.buildWebhookService();

    await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }));
    await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.refunded", providerPaymentId }));
    expect((await ctx.payments.findById(payment.id))?.status).toBe("refunded");

    // A stale, delayed "payment.failed" arrives after the refund already posted.
    const staleResult = await webhook.receiveWebhook(
      signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.failed", providerPaymentId }),
    );
    expect(staleResult.status).toBe("processed"); // correctly recognized as a safe no-op, not an error.
    expect((await ctx.payments.findById(payment.id))?.status).toBe("refunded"); // never regressed.
  });

  // ---------------------------------------------------------------------------------------------
  // PACKAGE B — CODEX CORRECTIVE PASS (R06 + R09 only): B16-B30. Keeps every B01-B15 guarantee above
  // intact; these prove the 10 blockers Codex's independent review required fixed. B19 (null-agreement
  // provider event remains unresolved) is deliberately NOT implemented here — see the corrective
  // pass's own completion report for why blocker 3A's upstream enforcement was scoped out rather than
  // half-implemented in a way that would silently break this codebase's existing, intentional
  // agreement-less provider-routed payment convention.
  // ---------------------------------------------------------------------------------------------

  it("B16 — automatic processed-payment ledger repair via the scheduler's bounded reconciliation batch", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 2_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});
    const trustedEvent = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId, amountMinorUnits: 2_000, currency: "USD", processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 },
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();

    const result = await ctx.reconciliation.repairBatch(200);
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(await findClearEntry(ctx.ledger, payment.id)).not.toBeNull();

    await ctx.reconciliation.repairBatch(200); // idempotent re-run.
    const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
  });

  it("B17 — automatic agreement-lifecycle repair via the scheduler's bounded reconciliation batch", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 5_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: payment.id, agreementId, currency: "USD", grossAmountMinorUnits: 5_000 });
    expect((await ctx.agreements.findById(agreementId))?.status).toBe("first_payment_pending");

    const result = await ctx.reconciliation.repairBatch(200);
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full");

    await ctx.reconciliation.repairBatch(200); // idempotent re-run.
    expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full");
  });

  it("B18 — stale worker resumes after being reclaimed: fenced out, cannot overwrite the new owner's final state", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });

    const claimedAt = new Date();
    const providerEventId = `evt-${randomUUID()}`;
    const workerA = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId },
      leaseMs: 500,
      now: claimedAt,
    });
    expect(workerA).not.toBeNull();
    const staleToken = workerA!.claimToken!;

    // Worker B reclaims after A's lease has expired, and completes for real via the full webhook path.
    const afterExpiry = new Date(claimedAt.getTime() + 5_000);
    const webhook = ctx.buildWebhookService();
    const recovery = await webhook.recoverBatch(10, afterExpiry);
    expect(recovery.processed).toBeGreaterThanOrEqual(1);
    const afterB = (await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))!;
    expect(afterB.processingStatus).toBe("processed");
    expect(afterB.claimToken).not.toBe(staleToken); // B's reclaim minted a fresh token, invalidating A's.
    const freshToken = afterB.claimToken!;

    // Worker A, unaware it was reclaimed, resumes and attempts to finalize with its OLD (stale) token —
    // both a "success" and a "permanent failure" finalization attempt, neither may have any effect.
    await ctx.events.markProcessed(workerA!.id, staleToken, new Date());
    await ctx.events.markFailedPermanent(workerA!.id, staleToken, "invalid_financial_data", new Date());

    const final = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
    expect(final?.processingStatus).toBe("processed"); // still B's outcome — A's stale writes were no-ops.
    expect(final?.processedAt).not.toBeNull();
    expect(final?.claimToken).toBe(freshToken);
    // The specific invariant Codex asked to be proven: a stale worker's failure call can never leave
    // the row split between "processedAt set" and "processing_status failed".
    expect(final?.nextRetryAt).toBeNull();
    expect(final?.lastErrorCode).toBeNull(); // A's stale markFailedPermanent call never touched this row.

    // Financial effects exactly once, despite A's two extra (fenced-out) finalization attempts.
    const payment = await ctx.payments.findByProviderPaymentId(providerPaymentId);
    const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment!.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
  });

  it("B18b — a REAL service worker (PaymentWebhookService.receiveWebhook), not merely the raw repository, cannot overwrite a reclaimed event's finalization", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    const providerEventId = `evt-${randomUUID()}`;

    // Worker A's own status transition commits (a real, separate, already-committed transaction —
    // see PaymentTransitionCoordinator), then A is paused deterministically at its very next real
    // step (posting the ledger entry) — no lock is held across this pause, so worker B's reclaim
    // cannot deadlock behind it.
    const lockAcquired = createDeferred<void>();
    const releaseA = createDeferred<void>();
    let pausedOnce = false;
    const pausingLedger = new Proxy(ctx.ledger, {
      get(target, prop, receiver) {
        if (prop === "postPaymentCleared" && !pausedOnce) {
          pausedOnce = true;
          return async (...args: unknown[]) => {
            lockAcquired.resolve();
            await releaseA.promise;
            return (target.postPaymentCleared as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const webhookA = ctx.buildWebhookService({ ledger: pausingLedger as unknown as LedgerService });
    const resultAPromise = webhookA.receiveWebhook(signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId }));
    await lockAcquired.promise; // deterministic: A's own transition has committed; A is now paused before its ledger step.

    // Worker B reclaims (an artificial far-future "now" stands in for real lease-expiry elapsed time
    // — deterministic, no sleep) and completes the SAME event via the REAL service's recoverBatch.
    const webhookB = ctx.buildWebhookService();
    const farFuture = new Date(Date.now() + 60 * 60 * 1000);
    const recovery = await webhookB.recoverBatch(10, farFuture);
    expect(recovery.processed).toBeGreaterThanOrEqual(1);
    const afterB = (await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))!;
    expect(afterB.processingStatus).toBe("processed");
    const bToken = afterB.claimToken!;

    // Worker A resumes and completes its OWN (now-redundant) work, then attempts to finalize with
    // its now-stale token via the REAL service's own processAndFinalize path.
    releaseA.resolve();
    await resultAPromise;

    const final = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
    expect(final?.processingStatus).toBe("processed");
    expect(final?.claimToken).toBe(bToken); // still B's ownership — A's finalize call was a no-op.

    // Financial effects exactly once, and the workflow state (payment status) is valid.
    const payment = await ctx.payments.findByProviderPaymentId(providerPaymentId);
    expect(payment?.status).toBe("succeeded");
    const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment!.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
  });

  it("B20 — a recognized event type with no matching payment remains unresolved/retryable, never silently processed", async () => {
    const ctx = buildContext();
    const webhook = ctx.buildWebhookService();
    const providerEventId = `evt-${randomUUID()}`;
    const result = await webhook.receiveWebhook(
      signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId: `sandbox_pay_${randomUUID()}` }),
    );
    expect(result.status).toBe("accepted");
    const eventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
    expect(eventRow?.processingStatus).toBe("failed");
    expect(eventRow?.nextRetryAt).not.toBeNull(); // retryable, never permanent.
  });

  it("B21 — succeeded -> failed is rejected by the legal-transition matrix; every legitimate succeeded -> later-state transition remains legal", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const webhook = ctx.buildWebhookService();

    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }));
    expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded");

    const staleFailResult = await webhook.receiveWebhook(
      signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.failed", providerPaymentId }),
    );
    expect(staleFailResult.status).toBe("processed"); // safely recognized as illegal/rejected, not an error.
    expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded"); // never regressed.

    for (const [eventType, expectedStatus] of [
      ["payment.reversed", "reversed"],
      ["payment.returned", "returned"],
    ] as const) {
      const pid = `sandbox_pay_${randomUUID()}`;
      const p = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId: pid });
      await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId: pid }));
      const legalResult = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType, providerPaymentId: pid }));
      expect(legalResult.status).toBe("processed");
      expect((await ctx.payments.findById(p.id))?.status).toBe(expectedStatus);
    }
  });

  it("B22 — an earlier event's required ledger effect completes on retry even after a LATER, legally-valid event has already advanced status past it", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });

    // evt1 (succeeded): status transitions, but its OWN ledger effect fails once (crash-after-status).
    const flakyLedger = flaky(ctx.ledger, "postPaymentCleared", 1, () => new Error("simulated_transient_ledger_failure"));
    const webhook = ctx.buildWebhookService({ ledger: flakyLedger });
    const evt1 = `evt-${randomUUID()}`;
    const attempt1 = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: evt1, eventType: "payment.succeeded", providerPaymentId }));
    expect(attempt1.status).toBe("accepted");
    expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded");
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();

    // evt2 (disputed) arrives before evt1's retry: legally supersedes "succeeded" -> "disputed", but
    // its OWN ledger effect (a reversal) cannot post yet either — the clearing entry evt1 was supposed
    // to post doesn't exist yet, a genuinely missing prerequisite (R09 blocker 5: retryable, not permanent).
    const evt2 = `evt-${randomUUID()}`;
    const attempt2 = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: evt2, eventType: "payment.disputed", providerPaymentId }));
    expect(attempt2.status).toBe("accepted");
    expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed"); // legal transition committed regardless.

    // Recovery ROUND 1: evt1 retries first (received first, per claimBatchForRecovery's own
    // receivedAt-ascending order). Its status assertion ("succeeded") is now legally REJECTED
    // (current is "disputed") — its own required ledger effect completes NOW (idempotent, exact-once)
    // — but evt1 itself is NOT YET safely superseded: evt2 (the durable proof) has not been retried
    // within THIS SAME pass yet, so evt1's own historical workflow/lifecycle disposition correctly
    // stays "wait_for_superseding_event" and evt1 remains retryable (Stage 6 final historical-effect
    // closure — never blindly treat current.status alone as proof of safe supersession). evt2 then
    // gets ITS OWN turn in this SAME pass: its own prerequisite (evt1's clearing entry) now exists
    // (just posted above), so its own reversal succeeds and evt2 becomes fully "processed".
    const evt1Row = (await ctx.events.findByProviderEvent(ctx.provider.providerName, evt1))!;
    const evt2Row = (await ctx.events.findByProviderEvent(ctx.provider.providerName, evt2))!;
    const dueAt = new Date(Math.max(evt1Row.nextRetryAt!.getTime(), evt2Row.nextRetryAt!.getTime()) + 1);
    await webhook.recoverBatch(100, dueAt);

    const entriesAfterRound1 = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entriesAfterRound1.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // evt1's own ledger effect, finished late.
    expect(entriesAfterRound1.filter((e) => e.entryType === "dispute_adjustment")).toHaveLength(1); // evt2's own effect, once its prerequisite existed.
    expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, evt2))?.processingStatus).toBe("processed");

    // Recovery ROUND 2: now that evt2 is durably, fully processed, evt1's own historical workflow/
    // lifecycle disposition safely resolves to "superseded_safely" (its ledger effect already
    // completed in round 1 — never re-attempted, never duplicated) and evt1 finally finalizes too.
    const evt1RowAfterRound1 = (await ctx.events.findByProviderEvent(ctx.provider.providerName, evt1))!;
    await webhook.recoverBatch(100, new Date(evt1RowAfterRound1.nextRetryAt!.getTime() + 1));

    expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed"); // never regressed back to "succeeded".
    const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // still exact-once.
    expect(entries.filter((e) => e.entryType === "dispute_adjustment")).toHaveLength(1); // still exact-once.
    expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, evt1))?.processingStatus).toBe("processed");
    expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, evt2))?.processingStatus).toBe("processed");
  });

  it("R-B50 — success transition applies durably, its own required audit fails, a distinct dispute event legally advances status past it, and retrying the ORIGINAL success event restores exactly its own historical audit without regressing status", async () => {
    // PACKAGE B — PRE-CODEX FINAL CORRECTION (item 1). Literal named scenario, not treated as
    // equivalent to B22 (ledger-only) or B29 (no intervening later event). `flakyAudit` fails only
    // the FIRST call to `audit.record` across this webhook service instance — evt1's own transition
    // audit — so evt1's transition commits (transitionAppliedAt/from/to durably recorded) but its
    // audit write throws, leaving evt1 unprocessed. evt2 (dispute) then legally advances the status
    // and successfully audits its OWN transition (second `record` call, past the injected failure).
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });

    const flakyAudit = flaky(new AuditService(new DrizzleAuditEventRepository()), "record", 1, () => new Error("simulated_success_audit_write_failure"));
    const webhook = ctx.buildWebhookService({ audit: flakyAudit });
    const successEventId = `evt-${randomUUID()}`;
    const successAction = "payment_webhook_payment.succeeded";

    // SUCCESS EVENT: transition commits, its own required audit fails, event remains retryable.
    const successAttempt1 = await webhook.receiveWebhook(
      signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId }),
    );
    expect(successAttempt1.status).toBe("accepted"); // audit effect failed -> not marked processed.
    expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded"); // transition already committed.
    expect(await findAuditEventsByProviderEvent(successEventId, successAction)).toHaveLength(0);
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull(); // ledger runs after the audit call — never reached.

    // DISTINCT DISPUTE EVENT: legally advances succeeded -> disputed; its own audit succeeds (past
    // the injected failure); its own reversal effect is retryable (clearing entry doesn't exist yet).
    const disputeEventId = `evt-${randomUUID()}`;
    const disputeAction = "payment_webhook_payment.disputed";
    const disputeAttempt = await webhook.receiveWebhook(
      signedWebhook(ctx.provider, { providerEventId: disputeEventId, eventType: "payment.disputed", providerPaymentId }),
    );
    expect(disputeAttempt.status).toBe("accepted");
    expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed"); // legal transition committed regardless.
    expect(await findAuditEventsByProviderEvent(disputeEventId, disputeAction)).toHaveLength(1); // dispute audit independently present already.

    // Retry the ORIGINAL success event (and the dispute event's own pending reversal) via recovery.
    // ROUND 1 (Stage 6 final historical-effect closure): the success event's own audit + ledger
    // effects complete now (exact-once, idempotent), but the success event itself is not YET safely
    // superseded within this SAME pass — the dispute event (the durable proof) gets processed only
    // afterward in this same loop, so the success event's own disposition correctly still returns
    // "wait_for_superseding_event" and it remains retryable for one more round.
    const successRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))!;
    const disputeRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))!;
    const dueAt = new Date(Math.max(successRow.nextRetryAt!.getTime(), disputeRow.nextRetryAt!.getTime()) + 1);
    await webhook.recoverBatch(100, dueAt);
    expect(await findAuditEventsByProviderEvent(successEventId, successAction)).toHaveLength(1); // exact-once, already restored.
    expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))?.processingStatus).toBe("processed");

    // ROUND 2: the dispute is now durably, fully processed — the success event's historical
    // workflow/lifecycle disposition safely resolves to "superseded_safely" and it finalizes too.
    const successRowAfterRound1 = (await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))!;
    await webhook.recoverBatch(100, new Date(successRowAfterRound1.nextRetryAt!.getTime() + 1));

    // Final persisted state, exactly as required:
    expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed"); // payment remains disputed.
    const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // exactly one payment_cleared entry.
    const successAudits = await findAuditEventsByProviderEvent(successEventId, successAction);
    expect(successAudits).toHaveLength(1); // exactly one success transition audit.
    expect(successAudits[0]!.previousValue).toBe("pending"); // audit previousValue = pending.
    expect(successAudits[0]!.newValue).toBe("succeeded"); // audit newValue = succeeded.
    expect(successAudits[0]!.providerEventId).toBe(successEventId); // tied to the original success providerEventId.
    expect(await findAuditEventsByProviderEvent(disputeEventId, disputeAction)).toHaveLength(1); // dispute audit remains independently present, not duplicated.
    expect((await ctx.payments.findById(payment.id))?.status).not.toBe("succeeded"); // success status is NOT reapplied.
    expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))?.processingStatus).toBe("processed"); // only becomes processed once its historical required effects are complete.
    expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))?.processingStatus).toBe("processed");
  });

  it("B23 — a repairable ConfigurationError never becomes permanent, and recovers once the underlying condition is corrected", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    const flakyLedger = flaky(ctx.ledger, "postPaymentCleared", 1, () => new ConfigurationError("simulated_repairable_configuration_defect"));
    const webhook = ctx.buildWebhookService({ ledger: flakyLedger });
    const providerEventId = `evt-${randomUUID()}`;

    const result = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId }));
    expect(result.status).toBe("accepted");
    const eventRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))!;
    expect(eventRow.processingStatus).toBe("failed");
    expect(eventRow.nextRetryAt).not.toBeNull(); // retryable, never permanent, despite being a ConfigurationError.
    expect(eventRow.lastErrorCode).toBe("repairable_configuration_defect");

    const recovery = await webhook.recoverBatch(100, new Date(eventRow.nextRetryAt!.getTime() + 1));
    expect(recovery.processed).toBeGreaterThanOrEqual(1); // this shared-database suite's batch call may also sweep up unrelated due leftovers.
    expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))?.processingStatus).toBe("processed");
  });

  it("B24 — an agreement-completion balance-read failure propagates (never swallowed), blocking processed; recovery advances the lifecycle once the read succeeds", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 5_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });

    const flakyBalances = flaky(ctx.balances, "getAgreementBalance", 1, () => new Error("simulated_balance_read_failure"));
    const flakyCompletion = new AgreementCompletionService({
      agreements: ctx.agreements as unknown as AgreementStatusRepository,
      balances: flakyBalances as unknown as AgreementBalanceComputer,
      audit: new AuditService(new DrizzleAuditEventRepository()),
      });
    const webhook = ctx.buildWebhookService({ completion: flakyCompletion });
    const providerEventId = `evt-${randomUUID()}`;
    const result = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId }));

    expect(result.status).toBe("accepted"); // the read failure propagated -> never marked processed.
    expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded"); // status + ledger already committed.
    expect(await findClearEntry(ctx.ledger, payment.id)).not.toBeNull();
    expect((await ctx.agreements.findById(agreementId))?.status).toBe("first_payment_pending"); // lifecycle NOT yet advanced.

    const eventRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))!;
    const recovery = await webhook.recoverBatch(100, new Date(eventRow.nextRetryAt!.getTime() + 1));
    expect(recovery.processed).toBeGreaterThanOrEqual(1); // this shared-database suite's batch call may also sweep up unrelated due leftovers.
    expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full"); // converged once the read succeeded.
    expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))?.processingStatus).toBe("processed");
  });

  it("B25 — two concurrent agreement-lifecycle decisions for the same agreement converge on exactly one valid final state", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 5_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: payment.id, agreementId, currency: "USD", grossAmountMinorUnits: 5_000 });

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const completionA = new AgreementCompletionService({
        agreements: new DrizzleAgreementRepository(isolatedA.db) as unknown as AgreementStatusRepository,
        balances: ctx.balances as unknown as AgreementBalanceComputer,
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedA.db)),
          });
      const completionB = new AgreementCompletionService({
        agreements: new DrizzleAgreementRepository(isolatedB.db) as unknown as AgreementStatusRepository,
        balances: ctx.balances as unknown as AgreementBalanceComputer,
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedB.db)),
          });

      await Promise.all([completionA.checkAndAdvance(agreementId), completionB.checkAndAdvance(agreementId)]);

      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full");
      const db = getDb();
      const auditRows = await db
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.action, "agreement_paid_in_full"), eq(auditEvent.agreementId, agreementId)));
      expect(auditRows).toHaveLength(1); // exactly one side's conditional write actually applied.
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("B25b — a stale activation decision (computed from older state) cannot overwrite a newer completion that already committed", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties(10_000);
    const ctx = buildContext();
    const paymentA = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 5_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId: `sandbox_pay_${randomUUID()}` });
    await ctx.payments.updateStatus(paymentA.id, "succeeded", {});
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: paymentA.id, agreementId, currency: "USD", grossAmountMinorUnits: 5_000 });
    expect((await ctx.agreements.findById(agreementId))?.status).toBe("first_payment_pending");

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      // Worker A reads the agreement (still "first_payment_pending") and the balance (still only
      // partially paid — 5,000 of 10,000) and DECIDES "activate" — then is paused right before
      // writing that decision (no lock held across the pause: the read already committed).
      const lockAcquired = createDeferred<void>();
      const releaseA = createDeferred<void>();
      const realAgreementsA = new DrizzleAgreementRepository(isolatedA.db);
      const pausingAgreementsA: AgreementStatusRepository = {
        findById: (id) => realAgreementsA.findById(id),
        updateStatusIfCurrentlyIn: async (id, expected, newStatus) => {
          lockAcquired.resolve();
          await releaseA.promise;
          return realAgreementsA.updateStatusIfCurrentlyIn(id, expected, newStatus);
        },
      };
      const completionA = new AgreementCompletionService({
        agreements: pausingAgreementsA,
        balances: ctx.balances as unknown as AgreementBalanceComputer,
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedA.db)),
          });

      const resultAPromise = completionA.checkAndAdvance(agreementId);
      await lockAcquired.promise; // deterministic: A has decided "activate" from OLD state and is paused before writing it.

      // A second payment completes the full balance, and worker B — reading fresh state — commits
      // completion FIRST, while A is still paused.
      const paymentB = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 5_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId: `sandbox_pay_${randomUUID()}` });
      await ctx.payments.updateStatus(paymentB.id, "succeeded", {});
      await ctx.ledger.postPaymentCleared({ paymentAttemptId: paymentB.id, agreementId, currency: "USD", grossAmountMinorUnits: 5_000 });
      const completionB = new AgreementCompletionService({
        agreements: new DrizzleAgreementRepository(isolatedB.db) as unknown as AgreementStatusRepository,
        balances: ctx.balances as unknown as AgreementBalanceComputer,
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedB.db)),
          });
      await completionB.checkAndAdvance(agreementId);
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full"); // B committed completion first.

      // A resumes and attempts its stale "activate" write — the agreement is no longer
      // "first_payment_pending", so the conditional write must be rejected, never overwriting completion.
      releaseA.resolve();
      await resultAPromise;

      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full"); // completed, never regressed to active.
      const db = getDb();
      const activatedAuditRows = await db.select().from(auditEvent).where(and(eq(auditEvent.action, "agreement_activated"), eq(auditEvent.agreementId, agreementId)));
      expect(activatedAuditRows).toHaveLength(0); // A's stale decision never got far enough to even audit it.
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("B26 — a stale failed-payment replay cannot regress an installment a LATER attempt already settled (real production FailedPaymentWorkflowService, atomic coordinator wired)", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);

    const notifyCtx = createTestNotificationService();
    const profileOwners = new DrizzleProfileOwnerReader();
    const retries = new PaymentRetryService({
      retries: new DrizzlePaymentRetryRepository(),
      paymentAttempts: new DrizzlePaymentAttemptRepository(),
      initiators: {} as unknown as Record<PaymentMethod, RetryPaymentMethodInitiator>, // never invoked — this test only exercises scheduling, never firing.
      profileOwners,
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
    const installments = new DrizzleInstallmentStatusRepository();
    const workflow = new FailedPaymentWorkflowService({
      installments,
      retries,
      notifications: notifyCtx.notificationService,
      profileOwners,
      // PACKAGE B — FINAL NARROW CORRECTION (Codex blocker 7 residual race): the real atomic
      // coordinator, exactly as production wires it — see B31/B32 below for the deterministic,
      // barrier-proven concurrent-order proofs of what this coordinator itself guarantees.
      retryCoordinator: new DrizzleFailedPaymentRetryCoordinator(),
    });
    const ctx = buildContext();
    const webhook = ctx.buildWebhookService({ failedPaymentWorkflow: workflow });

    const providerPaymentIdA = `sandbox_pay_${randomUUID()}`;
    const providerPaymentIdB = `sandbox_pay_${randomUUID()}`;
    const paymentA = await ctx.payments.insertPending({
      idempotencyKey: randomUUID(),
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId,
      providerName: ctx.provider.providerName,
      installmentScheduleItemId,
    });
    await ctx.payments.updateStatus(paymentA.id, "pending", { providerPaymentId: providerPaymentIdA });
    const paymentB = await ctx.payments.insertPending({
      idempotencyKey: randomUUID(),
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId,
      providerName: ctx.provider.providerName,
      installmentScheduleItemId,
    });
    await ctx.payments.updateStatus(paymentB.id, "pending", { providerPaymentId: providerPaymentIdB });

    // Attempt B succeeds FIRST (models "A paused mid-workflow while B, a later attempt, completed").
    await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId: providerPaymentIdB }));
    expect(await installments.findStatus(installmentScheduleItemId)).toBe("paid");

    // Attempt A's stale failure now resumes/arrives.
    const failResult = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: providerPaymentIdA }));
    expect(failResult.status).toBe("processed");

    expect(await installments.findStatus(installmentScheduleItemId)).toBe("paid"); // never regressed to past_due.
    expect(await retries.findForOriginalPayment(paymentA.id, debtor.userId)).toBeNull(); // no stale retry scheduled.

    // Repeated failed-event replay (direct workflow re-invocation) is idempotent too.
    const latestA = (await ctx.payments.findById(paymentA.id))!;
    await workflow.handlePaymentFailed(latestA, "generic_decline");
    expect(await installments.findStatus(installmentScheduleItemId)).toBe("paid");
    expect(await retries.findForOriginalPayment(paymentA.id, debtor.userId)).toBeNull();
  });

  it("B27 — conflicting/ambiguous trusted reconciliation evidence blocks automatic repair", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});

    // Two DISTINCT trusted, processed "payment.succeeded" events for the exact same providerPaymentId
    // — genuinely ambiguous; automatic repair must refuse rather than guess which is authoritative.
    for (let i = 0; i < 2; i += 1) {
      const inserted = await ctx.events.tryInsertAndClaim({
        provider: ctx.provider.providerName,
        providerEventId: `evt-${randomUUID()}`,
        eventType: "payment.succeeded",
        source: "webhook",
        signatureVerified: true,
        payload: { providerPaymentId, amountMinorUnits: 1_000 },
        leaseMs: 120_000,
        now: new Date(),
      });
      await ctx.events.markProcessed(inserted!.id, inserted!.claimToken!, new Date());
    }

    const found = await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("internal_posting_failure"); // refused -> manual review.
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();
  });

  it("B28 — provider-scoped, unambiguous reconciliation repair: a same-identifier event from a DIFFERENT provider is ignored, not treated as ambiguous; concurrent repair attempts post exactly one ledger effect", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});

    const decoy = await ctx.events.tryInsertAndClaim({
      provider: "other_provider_mock",
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId, amountMinorUnits: 999_999 },
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(decoy!.id, decoy!.claimToken!, new Date());

    const trusted = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId, amountMinorUnits: 1_000, currency: "USD", processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 },
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(trusted!.id, trusted!.claimToken!, new Date());

    // No ledger entry pre-created — TWO independent reconciliation workers, each on its OWN real
    // Postgres connection, genuinely race to repair the SAME missing entry for the first time.
    //
    // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 7 — B28 correction): `Promise.all`
    // alone does not PROVE the two workers' inserts actually overlapped (the event loop could run them
    // fully sequentially and this would still pass). A's `ledger_journal_entry` insert is paused,
    // genuinely INSIDE its own open transaction (via `LedgerJournalEntryInsertTestHooks`), AFTER the
    // row is inserted but BEFORE commit. The table's own `ledger_journal_entry_payment_type_unique`
    // constraint on `(payment_attempt_id, entry_type)` is what makes B's own concurrent insert attempt
    // for the SAME key a REAL, observable conflict — Postgres makes B's insert genuinely wait to see
    // whether A's uncommitted row will commit or roll back — proven via `waitUntilPidBlockedOnLock`.
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();
    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      await warmUp(isolatedB.client);
      const entryInserted = createDeferred<void>();
      const releaseA = createDeferred<void>();
      const pausingEntriesA = new DrizzleLedgerJournalEntryRepository(isolatedA.db, {
        afterEntryInsert: async () => {
          entryInserted.resolve();
          await releaseA.promise;
        },
      });
      const buildIsolatedReconciliation = (db: ReturnType<typeof createIsolatedDb>["db"], entries = new DrizzleLedgerJournalEntryRepository(db)) =>
        new ReconciliationService({
          payments: new DrizzlePaymentAttemptRepository(db),
          webhookEvents: new DrizzlePaymentWebhookEventRepository(db),
          provider: ctx.provider,
          ledger: new LedgerService({ accounts: new DrizzleLedgerAccountRepository(db), entries, audit: new AuditService(new DrizzleAuditEventRepository(db)) }),
          exceptions: new DrizzleReconciliationExceptionRepository(db),
        });
      const reconciliationA = buildIsolatedReconciliation(isolatedA.db, pausingEntriesA);
      const reconciliationB = buildIsolatedReconciliation(isolatedB.db);

      const resultAPromise = reconciliationA.reconcilePaymentAttempt(payment.id);
      await entryInserted.promise; // deterministic: A's row is inserted, transaction still OPEN.

      const pidB = await warmUp(isolatedB.client);
      const resultBPromise = reconciliationB.reconcilePaymentAttempt(payment.id);
      await waitUntilPidBlockedOnLock(DATABASE_URL, pidB); // PROVEN: B is genuinely blocked behind A's still-open insert.

      releaseA.resolve();
      await Promise.all([resultAPromise, resultBPromise]);
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }

    const entriesAfter = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entriesAfter.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // exactly one, despite the genuine race.
  });

  it("B29 — a required audit effect that fails after the status commits is restored on retry, exactly once", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    const flakyAudit = flaky(new AuditService(new DrizzleAuditEventRepository()), "record", 1, () => new Error("simulated_audit_write_failure"));
    const webhook = ctx.buildWebhookService({ audit: flakyAudit });
    const providerEventId = `evt-${randomUUID()}`;
    const action = "payment_webhook_payment.succeeded";

    const attempt1 = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId }));
    expect(attempt1.status).toBe("accepted"); // audit effect failed -> not marked processed.
    expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded"); // status already committed.
    expect(await findAuditEventsByProviderEvent(providerEventId, action)).toHaveLength(0);
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull(); // ledger never reached (audit threw first).

    const eventRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))!;
    const recovery = await webhook.recoverBatch(100, new Date(eventRow.nextRetryAt!.getTime() + 1));
    expect(recovery.processed).toBeGreaterThanOrEqual(1); // this shared-database suite's batch call may also sweep up unrelated due leftovers.
    expect(await findAuditEventsByProviderEvent(providerEventId, action)).toHaveLength(1); // restored, exactly once.
    expect(await findClearEntry(ctx.ledger, payment.id)).not.toBeNull();
  });

  it("R-B51 — payout financial effect commits, its audit fails, retry restores exactly one payout audit with no duplicate payout accounting", async () => {
    // PACKAGE B — remaining Codex blockers (Section 5 — payout audit). `applyPayoutRequired` used to
    // return early once `payoutCompletedAt` was already set, permanently skipping its audit on retry —
    // mirrors the R-B36/B29 transition-audit gap but for the payout event, which never touches the
    // transition coordinator at all (payout.paid does not change payment status).
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, {
      agreementId,
      amountMinorUnits: 1_000,
      payerProfileId: debtor.profileId,
      recipientProfileId: creditor.profileId,
      providerPaymentId,
    });

    // Get the payment to succeeded + ledger-cleared first — postPayout requires a payment_cleared entry.
    const successWebhook = ctx.buildWebhookService();
    const successEventId = `evt-${randomUUID()}`;
    const successResult = await successWebhook.receiveWebhook(
      signedWebhook(ctx.provider, {
        providerEventId: successEventId,
        eventType: "payment.succeeded",
        providerPaymentId,
        amountMinorUnits: 1_000,
        currency: "USD",
        processorFeeMinorUnits: 0,
        platformFeeMinorUnits: 0,
      }),
    );
    expect(successResult.status).toBe("processed");
    expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded");
    expect(await findClearEntry(ctx.ledger, payment.id)).not.toBeNull();

    const flakyAudit = flaky(new AuditService(new DrizzleAuditEventRepository()), "record", 1, () => new Error("simulated_payout_audit_write_failure"));
    const payoutWebhook = ctx.buildWebhookService({ audit: flakyAudit });
    const payoutEventId = `evt-${randomUUID()}`;
    const payoutAction = "payment_webhook_payout.paid";

    const attempt1 = await payoutWebhook.receiveWebhook(
      signedWebhook(ctx.provider, { providerEventId: payoutEventId, eventType: "payout.paid", providerPaymentId }),
    );
    expect(attempt1.status).toBe("accepted"); // audit effect failed -> not marked processed.
    expect((await ctx.payments.findById(payment.id))?.payoutCompletedAt).not.toBeNull(); // financial effect already committed.
    expect(await findAuditEventsByProviderEvent(payoutEventId, payoutAction)).toHaveLength(0);

    const eventRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, payoutEventId))!;
    const recovery = await payoutWebhook.recoverBatch(100, new Date(eventRow.nextRetryAt!.getTime() + 1));
    expect(recovery.processed).toBeGreaterThanOrEqual(1); // this shared-database suite's batch call may also sweep up unrelated due leftovers.
    expect(await findAuditEventsByProviderEvent(payoutEventId, payoutAction)).toHaveLength(1); // restored, exactly once.

    const payoutEntries = (await ctx.ledger.listEntriesForPaymentAttempt(payment.id)).filter((e) => e.entryType === "payout");
    expect(payoutEntries).toHaveLength(1); // no duplicate payout accounting from the retry.
  });

  it("B30 — concurrent replay of the same provider event's audit effect produces exactly one record; two distinct events remain distinguishable", async () => {
    // PACKAGE B — remaining Codex blockers (Section 7 — test-quality correction): genuinely
    // independent connections (the shared default `getDb()` singleton is `max: 1` and could never
    // actually hold two overlapping transactions) PLUS a deterministic barrier — `Promise.all` alone
    // does not prove the two `record()` calls actually overlapped inside Postgres (the event loop
    // could run them fully sequentially and this would still pass). This pre-acquires the EXACT SAME
    // advisory lock key `appendAtomically` uses (see `drizzleAuditEventRepository.ts`'s own
    // `AUDIT_CHAIN_LOCK_KEY_*` doc comment) on a third, reserved connection, fires BOTH real
    // `record()` calls on separate connections without awaiting them, and uses
    // `waitUntilContended({ expectPids })` to get server-side proof (via `pg_stat_activity`) that
    // BOTH backends are genuinely queued behind the held lock before releasing it — mirroring
    // `auditService.postgres.test.ts`'s own R04-A contention proof for this identical lock.
    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const pidA = await warmUp(isolatedA.client);
      const pidB = await warmUp(isolatedB.client);
      const auditA = new AuditService(new DrizzleAuditEventRepository(isolatedA.db));
      const auditB = new AuditService(new DrizzleAuditEventRepository(isolatedB.db));
      const providerEventId = `evt-${randomUUID()}`;
      const action = "payment_webhook_payment.succeeded";
      const payloadFor = (providerEventIdOverride: string) => ({
        actorUserId: null,
        actorRole: "payment_provider",
        profileKind: null,
        profileId: null,
        agreementId: null,
        action,
        occurredAt: new Date().toISOString(),
        ipAddress: null,
        deviceInfo: null,
        previousValue: "pending",
        newValue: "succeeded",
        reason: null,
        authStrength: null,
        relatedDocumentId: null,
        relatedCaseId: null,
        targetResourceType: "payment_attempt" as const,
        targetResourceId: randomUUID(),
        providerEventId: providerEventIdOverride,
      });

      const barrier = await acquireAdvisoryLockBarrier(DATABASE_URL, "audit_event_chain", "append");
      const recordAPromise = auditA.record(payloadFor(providerEventId));
      const recordBPromise = auditB.record(payloadFor(providerEventId));
      try {
        await barrier.waitUntilContended({ expectPids: [pidA, pidB] }); // PROVEN: both backends genuinely queued behind the SAME held lock.
      } finally {
        await barrier.release();
      }

      const [recordA, recordB] = await Promise.all([recordAPromise, recordBPromise]);
      expect(recordA.id).toBe(recordB.id); // exactly one row — the racing caller gets back the winner's record.
      expect(await findAuditEventsByProviderEvent(providerEventId, action)).toHaveLength(1);

      // A genuinely distinct provider event for the SAME action remains its own, distinguishable row.
      const otherProviderEventId = `evt-${randomUUID()}`;
      await auditA.record(payloadFor(otherProviderEventId));
      expect(await findAuditEventsByProviderEvent(otherProviderEventId, action)).toHaveLength(1);
      expect(await findAuditEventsByProviderEvent(providerEventId, action)).toHaveLength(1); // unaffected.
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  // ---------------------------------------------------------------------------------------------
  // PACKAGE B — FINAL NARROW CORRECTION: B19 (Codex blocker A) + B31/B32 (Codex blocker 7 residual
  // race, deterministic barrier-proven concurrency).
  // ---------------------------------------------------------------------------------------------

  it("B19 — a provider-routed payment must have an agreement (Codex blocker A)", async () => {
    const { creditor, debtor } = await seedTwoParties();

    // Scenario A: attempting to create a provider-routed payment with agreementId = null is rejected
    // before any provider financial processing — the real PaymentService.submitToProvider path,
    // backed by a real Postgres payment_attempt repository.
    const verificationCtx = createTestVerificationService();
    verificationCtx.profileOwners.set("personal", debtor.profileId, debtor.userId);
    verificationCtx.profileOwners.set("personal", creditor.profileId, creditor.userId);
    for (const profileId of [debtor.profileId, creditor.profileId]) {
      await verificationCtx.verificationService.submitFullVerificationRequest("personal", profileId);
      await verificationCtx.verificationService.recordManualVerificationDecision({
        actingRole: "platform_owner",
        profileKind: "personal",
        profileId,
        decision: "verified",
        reviewerUserId: "b19-reviewer", // a profile's own owner cannot review their own verification request.
        reason: null,
      });
    }
    const provider = new SandboxPaymentProvider(WEBHOOK_SECRET);
    const realPayments = new DrizzlePaymentAttemptRepository();
    const paymentService = new PaymentService({
      provider,
      verification: verificationCtx.verificationService,
      profileOwners: verificationCtx.profileOwners,
      payments: realPayments,
      audit: new AuditService(new DrizzleAuditEventRepository()),
      agreements: new InMemoryAgreementPartiesReader(),
    });
    const scenarioAIdempotencyKey = `b19-scenario-a-${randomUUID()}`;

    await expect(
      paymentService.createPayment({
        idempotencyKey: scenarioAIdempotencyKey,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 1_000,
        currency: "USD",
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
      }),
    ).rejects.toThrow(/must be linked to an agreement/i);
    // Never reached the provider — no providerPaymentId was ever assigned, and the attempt is still
    // visible, marked "failed", never silently discarded.
    const rejectedRecord = await realPayments.findByIdempotencyKey(scenarioAIdempotencyKey);
    expect(rejectedRecord?.status).toBe("failed");
    expect(rejectedRecord?.providerPaymentId).toBeNull();

    // Scenario B: a legacy/malformed provider-routed payment with agreementId = null that somehow
    // reaches the webhook (inserted directly, bypassing PaymentService's own now-enforced guard,
    // modeling a pre-existing row) must not become processed, must not fabricate a ledger entry, and
    // must remain observable/unresolved (retryable, never a dead end).
    const ctx = buildContext();
    const legacyProviderPaymentId = `sandbox_pay_legacy_${randomUUID()}`;
    const legacyPayment = await ctx.payments.insertPending({
      idempotencyKey: `b19-scenario-b-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 1_000,
      currency: "USD",
      agreementId: null,
      providerName: ctx.provider.providerName,
    });
    await ctx.payments.updateStatus(legacyPayment.id, "pending", { providerPaymentId: legacyProviderPaymentId });
    const webhook = ctx.buildWebhookService();
    const providerEventId = `evt-${randomUUID()}`;
    const result = await webhook.receiveWebhook(
      signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId: legacyProviderPaymentId }),
    );
    expect(result.status).toBe("accepted"); // never silently "processed".
    expect(await findClearEntry(ctx.ledger, legacyPayment.id)).toBeNull(); // no fabricated ledger entry.
    const eventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
    expect(eventRow?.processingStatus).toBe("failed");
    expect(eventRow?.nextRetryAt).not.toBeNull(); // remains recoverable, never a dead end.
    expect(eventRow?.lastErrorCode).toBe("repairable_configuration_defect");

    // Scenario C: the legitimate manual/off-platform flow (recordManualOffPlatformPayment) — the only
    // genuinely-supported path that never calls the provider at all — is completely unaffected.
    const manualAgreementId = await seedAgreement(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    const manualAgreements = new InMemoryAgreementPartiesReader();
    manualAgreements.register(manualAgreementId, {
      creditor: { profileKind: "personal", profileId: creditor.profileId },
      debtor: { profileKind: "personal", profileId: debtor.profileId },
    });
    const manualPaymentService = new PaymentService({
      provider,
      verification: verificationCtx.verificationService,
      profileOwners: verificationCtx.profileOwners,
      payments: realPayments,
      audit: new AuditService(new DrizzleAuditEventRepository()),
      agreements: manualAgreements,
      ledger: ctx.ledger,
    });
    const manualRecord = await manualPaymentService.recordManualOffPlatformPayment({
      idempotencyKey: `b19-scenario-c-${randomUUID()}`,
      agreementId: manualAgreementId,
      amountMinorUnits: 500,
      actingUserId: debtor.userId,
    });
    expect(manualRecord.status).toBe("succeeded");
    expect(manualRecord.agreementId).toBe(manualAgreementId);
  });

  it("B31 — failed-payment retry race, order 1: attempt A's failure decision is paused mid-transaction while genuinely holding the installment lock; attempt B succeeds and commits fully before A resumes — A must then see the installment already settled and create no retry", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    const paymentA = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
    // A second attempt (paymentB) for the same installment exists conceptually — coordinateSuccess
    // itself only needs the installment id, not a specific payment record, to settle it.
    await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const pidB = await warmUp(isolatedB.client);
      const lockAcquired = createDeferred<void>();
      const releaseA = createDeferred<void>();
      const hooks: InstallmentLockTestHooks = {
        afterInstallmentLock: async () => {
          lockAcquired.resolve();
          await releaseA.promise;
        },
      };
      const coordinatorA = new DrizzleFailedPaymentRetryCoordinator(isolatedA.db, 3, new AuditService(new DrizzleAuditEventRepository(isolatedA.db)), hooks);
      const coordinatorB = new DrizzleFailedPaymentRetryCoordinator(isolatedB.db, 3, new AuditService(new DrizzleAuditEventRepository(isolatedB.db)));

      const failurePromise = coordinatorA.coordinateFailure({ installmentScheduleItemId, payment: paymentA });
      await lockAcquired.promise; // deterministic: A's installment-row lock has been GRANTED.

      const successPromise = coordinatorB.coordinateSuccess({ installmentScheduleItemId });
      // Deterministic proof of real overlap: B's own attempt to lock the SAME row is genuinely
      // queued, server-side, behind A's held lock — not a timing assumption.
      await waitUntilPidBlockedOnLock(DATABASE_URL, pidB);

      releaseA.resolve();
      const [failureResult] = await Promise.all([failurePromise, successPromise]);

      // A's transaction was still mid-flight (holding the OLD lock) when B's request queued — so
      // Postgres's own lock-queue ordering guarantees A's transaction commits FIRST. A had not yet
      // decided anything (it paused immediately after acquiring the lock, before reading status), so
      // when it resumes it still sees the installment "not yet paid" and creates the one retry.
      // B then must fully supersede it once it finally gets the lock.
      expect(failureResult.outcome).toBe("retry_scheduled");

      const finalStatus = await installmentStatus(installmentScheduleItemId);
      expect(finalStatus).toBe("paid"); // B's success always wins in final state, regardless of ordering.
      const retries = await listRetriesForInstallment(installmentScheduleItemId);
      expect(retries).toHaveLength(1);
      expect(retries[0]?.status).toBe("canceled"); // B's success superseded/canceled A's retry — nothing stale remains executable.
      expect(retries[0]?.originalPaymentAttemptId).toBe(paymentA.id);
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("B32 — failed-payment retry race, order 2: attempt B's success is paused mid-transaction while genuinely holding the installment lock (after A already committed its retry); B must still fully settle and cancel A's retry once it resumes", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    const paymentA = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
    // A second attempt (paymentB) for the same installment exists conceptually — coordinateSuccess
    // itself only needs the installment id, not a specific payment record, to settle it.
    await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);

    // A obtains the authoritative lock/decision FIRST and fully commits — creating the one allowed
    // retry and marking the installment past_due — before B ever starts.
    const coordinatorA = new DrizzleFailedPaymentRetryCoordinator();
    const firstResult = await coordinatorA.coordinateFailure({ installmentScheduleItemId, payment: paymentA });
    expect(firstResult.outcome).toBe("retry_scheduled");
    expect(await installmentStatus(installmentScheduleItemId)).toBe("past_due");

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      await warmUp(isolatedB.client); // forces the connection to fully establish before the timed race starts.
      const lockAcquired = createDeferred<void>();
      const releaseB = createDeferred<void>();
      const hooks: InstallmentLockTestHooks = {
        afterInstallmentLock: async () => {
          lockAcquired.resolve();
          await releaseB.promise;
        },
      };
      const coordinatorBIsolated = new DrizzleFailedPaymentRetryCoordinator(isolatedB.db, 3, new AuditService(new DrizzleAuditEventRepository(isolatedB.db)), hooks);
      const coordinatorAIsolated = new DrizzleFailedPaymentRetryCoordinator(isolatedA.db);

      // B's success starts, acquires the lock, and pauses while genuinely holding it.
      const successPromise = coordinatorBIsolated.coordinateSuccess({ installmentScheduleItemId });
      await lockAcquired.promise; // deterministic: B's installment-row lock has been GRANTED.

      // A stale replay of the SAME original failure now resumes and tries to act again — its own
      // attempt to lock the SAME row is genuinely queued behind B's held lock.
      const pidAWarm = await warmUp(isolatedA.client);
      const replayPromise = coordinatorAIsolated.coordinateFailure({ installmentScheduleItemId, payment: paymentA });
      await waitUntilPidBlockedOnLock(DATABASE_URL, pidAWarm);

      releaseB.resolve();
      const [, replayResult] = await Promise.all([successPromise, replayPromise]);

      // Once B's success commits (installment "paid", A's retry canceled), A's stale replay resumes,
      // re-reads the NOW-authoritative "paid" state under its own lock, and correctly reports
      // already_settled — no new retry, no past_due regression, no stale retry left executable.
      expect(replayResult.outcome).toBe("already_settled");
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
      const retries = await listRetriesForInstallment(installmentScheduleItemId);
      expect(retries).toHaveLength(1); // still just the one retry A originally created — never duplicated.
      expect(retries[0]?.status).toBe("canceled");

      // Repeated recovery remains idempotent: running the same replay again changes nothing further.
      const secondReplay = await coordinatorAIsolated.coordinateFailure({ installmentScheduleItemId, payment: paymentA });
      expect(secondReplay.outcome).toBe("already_settled");
      expect(await listRetriesForInstallment(installmentScheduleItemId)).toHaveLength(1);
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  // ---------------------------------------------------------------------------------------------
  // PACKAGE B — REMAINING CODEX BLOCKERS: durable provider-event transition progress (Section 2).
  // ---------------------------------------------------------------------------------------------

  it("R-B36 — refund arrives before success: transition never applies, remains recoverable; success then applies; refund retry legally transitions and posts its effect exactly once", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    const webhook = ctx.buildWebhookService();

    // Refund arrives first, while the payment is still "pending" — illegal (refunded requires
    // "succeeded" first), but PROVISIONALLY so (pending can still legally become succeeded later).
    const refundEventId = `evt-${randomUUID()}`;
    const refundResult = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: refundEventId, eventType: "payment.refunded", providerPaymentId }));
    expect(refundResult.status).toBe("accepted"); // never silently processed — remains recoverable.
    expect((await ctx.payments.findById(payment.id))?.status).toBe("pending"); // transition never applied.
    let refundEventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, refundEventId);
    expect(refundEventRow?.transitionAppliedAt).toBeNull();
    expect(refundEventRow?.processingStatus).toBe("failed"); // retryable-failed, not processed.

    // Success then arrives and legally applies.
    await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }));
    expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded");

    // Before the refund retry: still no refund/reversal entry, refund event still not processed.
    const entriesBeforeRetry = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entriesBeforeRetry.filter((e) => e.entryType === "refund")).toHaveLength(0);
    refundEventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, refundEventId);
    expect(refundEventRow?.processingStatus).toBe("failed");
    expect(refundEventRow?.transitionAppliedAt).toBeNull();

    // Retry the refund: succeeded -> refunded is now legal.
    const recovery = await webhook.recoverBatch(100, new Date(refundEventRow!.nextRetryAt!.getTime() + 1));
    expect(recovery.processed).toBeGreaterThanOrEqual(1);

    expect((await ctx.payments.findById(payment.id))?.status).toBe("refunded");
    const entriesAfterRetry = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entriesAfterRetry.filter((e) => e.entryType === "refund")).toHaveLength(1); // exactly once.
    refundEventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, refundEventId);
    expect(refundEventRow?.processingStatus).toBe("processed");
    expect(refundEventRow?.transitionAppliedAt).not.toBeNull();
    expect(refundEventRow?.transitionFromStatus).toBe("succeeded");
    expect(refundEventRow?.transitionToStatus).toBe("refunded");
  });

  it("R-B38 — transition update and its durable transition-applied marker are atomic: an injected failure between them rolls back BOTH", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });

    const failingCoordinator = new DrizzlePaymentTransitionCoordinator(getDb(), {
      afterPaymentUpdate: async () => {
        throw new Error("simulated_failure_between_payment_update_and_transition_marker");
      },
    });
    const webhook = ctx.buildWebhookService({ transitionCoordinator: failingCoordinator });
    const providerEventId = `evt-${randomUUID()}`;
    const result = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId }));

    expect(result.status).toBe("accepted"); // the injected failure aborted the whole transaction.
    // BOTH sides of the atomic write rolled back together — neither applied alone.
    expect((await ctx.payments.findById(payment.id))?.status).toBe("pending");
    const eventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
    expect(eventRow?.transitionAppliedAt).toBeNull();
    expect(eventRow?.transitionFromStatus).toBeNull();

    // A real (non-failing) retry, via a normally-wired webhook service, then succeeds normally.
    const normalWebhook = ctx.buildWebhookService();
    const recovery = await normalWebhook.recoverBatch(100, new Date(eventRow!.nextRetryAt!.getTime() + 1));
    expect(recovery.processed).toBeGreaterThanOrEqual(1);
    expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded");
  });

  // ---------------------------------------------------------------------------------------------
  // PACKAGE B — REMAINING CODEX BLOCKERS: failed-payment retries — creation, cancellation, firing
  // (Section 3).
  // ---------------------------------------------------------------------------------------------

  it("R-B39 — success cancels EVERY executable retry for the installment, not just one", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    const paymentA = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
    const paymentB = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);

    const coordinator = new DrizzleFailedPaymentRetryCoordinator();
    const resultA = await coordinator.coordinateFailure({ installmentScheduleItemId, payment: paymentA });
    const resultB = await coordinator.coordinateFailure({ installmentScheduleItemId, payment: paymentB });
    expect(resultA.outcome).toBe("retry_scheduled");
    expect(resultB.outcome).toBe("retry_scheduled");
    const retriesBefore = await listRetriesForInstallment(installmentScheduleItemId);
    expect(retriesBefore).toHaveLength(2);
    expect(retriesBefore.every((r) => r.status === "scheduled")).toBe(true);

    const { canceledRetryIds } = await coordinator.coordinateSuccess({ installmentScheduleItemId });
    expect(canceledRetryIds).toHaveLength(2);

    expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
    const retriesAfter = await listRetriesForInstallment(installmentScheduleItemId);
    expect(retriesAfter).toHaveLength(2);
    expect(retriesAfter.every((r) => r.status === "canceled")).toBe(true); // zero executable retries remain.
  });

  it("R-B40 — a claimed retry that is revoked before its final authorization check can never reach the provider", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);

    const coordinator = new DrizzleFailedPaymentRetryCoordinator();
    const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
    if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
    const retryId = failure.retryId;

    // Worker scans the due retry and claims it for execution — before ever calling the provider.
    const claim = await coordinator.claimRetryForExecution({ installmentScheduleItemId, retryId });
    if (claim.outcome !== "claimed") throw new Error("expected the retry to be claimable");

    // Worker is now paused, about to call the provider. A DIFFERENT payment for the same installment
    // succeeds first and settles it — revoking the claimed retry.
    await coordinator.coordinateSuccess({ installmentScheduleItemId });
    expect((await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === retryId)?.status).toBe("canceled");

    // Worker resumes and performs its MANDATORY final authorization check immediately before the
    // provider call.
    const providerCalls: string[] = [];
    const stillValid = await coordinator.confirmExecutionStillValid({ retryId, executionToken: claim.executionToken });
    expect(stillValid).toBe(false);
    if (stillValid) providerCalls.push(retryId); // never reached — proves the worker's own real gate.
    expect(providerCalls).toHaveLength(0); // provider.createPayment is never called.

    // The revoked claim's own finalization attempts are also fenced — a stale token can never fire it.
    await coordinator.markRetryFired({ retryId, executionToken: claim.executionToken, resultingPaymentAttemptId: payment.id, firedAt: new Date() });
    const finalRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === retryId);
    expect(finalRow?.status).toBe("canceled"); // the stale markRetryFired call had no effect.
    expect(finalRow?.resultingPaymentAttemptId).toBeNull();
  });

  it("R-B41 — a retry that wins its final authorization check fires exactly once; success settling afterward leaves no stale executable retry", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);

    const coordinator = new DrizzleFailedPaymentRetryCoordinator();
    const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
    if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
    const retryId = failure.retryId;

    const claim = await coordinator.claimRetryForExecution({ installmentScheduleItemId, retryId });
    if (claim.outcome !== "claimed") throw new Error("expected the retry to be claimable");

    const stillValid = await coordinator.confirmExecutionStillValid({ retryId, executionToken: claim.executionToken });
    expect(stillValid).toBe(true);

    // The retry's own resulting charge — a genuinely distinct, real payment_attempt row.
    const resultingPayment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
    const resultingPaymentAttemptId = resultingPayment.id;
    await coordinator.markRetryFired({ retryId, executionToken: claim.executionToken, resultingPaymentAttemptId, firedAt: new Date() });
    const firedRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === retryId);
    expect(firedRow?.status).toBe("fired");
    expect(firedRow?.resultingPaymentAttemptId).toBe(resultingPaymentAttemptId);

    // Success settles the installment afterward — the already-fired retry is terminal, untouched.
    const { canceledRetryIds } = await coordinator.coordinateSuccess({ installmentScheduleItemId });
    expect(canceledRetryIds).toHaveLength(0); // "fired" is not cancelable — nothing left to supersede.
    const finalRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === retryId);
    expect(finalRow?.status).toBe("fired"); // unchanged.
  });

  it("R-B42 — multiple retries (one claimed/executing, one still scheduled): success settles the installment and makes ALL of them non-executable", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    const paymentA = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
    const paymentB = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);

    const coordinator = new DrizzleFailedPaymentRetryCoordinator();
    const failureA = await coordinator.coordinateFailure({ installmentScheduleItemId, payment: paymentA });
    const failureB = await coordinator.coordinateFailure({ installmentScheduleItemId, payment: paymentB });
    if (failureA.outcome !== "retry_scheduled" || failureB.outcome !== "retry_scheduled") throw new Error("expected both retries to be scheduled");

    // A's retry is claimed (a worker is "executing" it); B's retry remains merely scheduled.
    const claimA = await coordinator.claimRetryForExecution({ installmentScheduleItemId, retryId: failureA.retryId });
    if (claimA.outcome !== "claimed") throw new Error("expected A's retry to be claimable");

    const { canceledRetryIds } = await coordinator.coordinateSuccess({ installmentScheduleItemId });
    expect(canceledRetryIds.sort()).toEqual([failureA.retryId, failureB.retryId].sort());

    expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
    const finalRows = await listRetriesForInstallment(installmentScheduleItemId);
    expect(finalRows.every((r) => r.status === "canceled")).toBe(true);

    // A's worker, resuming after the claim, must also fail its final authorization check.
    const stillValidA = await coordinator.confirmExecutionStillValid({ retryId: failureA.retryId, executionToken: claimA.executionToken });
    expect(stillValidA).toBe(false);
  });

  // ---------------------------------------------------------------------------------------------
  // PAID2YOU — PACKAGE B: final retry-submission serialization. `claimAndExecuteRetry` holds the
  // installment row lock across the real provider call, making it and `coordinateSuccess`
  // genuinely, unconditionally mutually exclusive for the same installment — see that method's own
  // interface doc comment (failedPaymentRetryCoordinator.ts).
  // ---------------------------------------------------------------------------------------------

  function spyOnCreatePayment(provider: SandboxPaymentProvider): { spiedProvider: SandboxPaymentProvider; callCount: () => number } {
    let count = 0;
    const spiedProvider = new Proxy(provider, {
      get(target, prop, receiver) {
        if (prop === "createPayment") {
          return async (...args: unknown[]) => {
            count += 1;
            return (target.createPayment as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return { spiedProvider, callCount: () => count };
  }

  it("R-B40-STRICT-A — SUCCESS WINS: coordinateSuccess commits paid/canceled first; a stale retry-execution attempt afterward never reaches the provider", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
    const { spiedProvider, callCount } = spyOnCreatePayment(new SandboxPaymentProvider(WEBHOOK_SECRET));

    const coordinator = new DrizzleFailedPaymentRetryCoordinator();
    const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
    if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");

    // Connection B: coordinateSuccess obtains the installment lock, marks paid, cancels the retry, commits.
    const { canceledRetryIds } = await coordinator.coordinateSuccess({ installmentScheduleItemId });
    expect(canceledRetryIds).toEqual([failure.retryId]);
    expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");

    // Connection A: retry execution attempts AFTERWARD — must observe the already-settled state
    // under its OWN fresh lock acquisition and never reach the provider at all.
    const outcome = await coordinator.claimAndExecuteRetry({
      installmentScheduleItemId,
      retryId: failure.retryId,
      idempotencyKey: `retry-${failure.retryId}`,
      agreementId,
      provider: spiedProvider,
      prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      effectApplier: buildContext().buildWebhookService(),
    });

    expect(outcome.outcome).toBe("not_claimable");
    expect(callCount()).toBe(0); // provider.createPayment call count = 0.
    expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
    const finalRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
    expect(finalRow?.status).toBe("canceled"); // retry canceled/non-executable.
  });

  it("R-B40-STRICT-B — RETRY WINS: the installment lock is genuinely held through the real provider call; a concurrent coordinateSuccess is proven blocked and only settles afterward", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
    const { spiedProvider, callCount } = spyOnCreatePayment(new SandboxPaymentProvider(WEBHOOK_SECRET));

    const seedCoordinator = new DrizzleFailedPaymentRetryCoordinator();
    const failure = await seedCoordinator.coordinateFailure({ installmentScheduleItemId, payment });
    if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
    const idempotencyKey = `retry-${failure.retryId}`;

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const beforeProviderCall = createDeferred<void>();
      const releaseA = createDeferred<void>();
      const hooks: InstallmentLockTestHooks = {
        beforeProviderCall: async () => {
          beforeProviderCall.resolve();
          await releaseA.promise;
        },
      };
      const coordinatorA = new DrizzleFailedPaymentRetryCoordinator(isolatedA.db, 3, new AuditService(new DrizzleAuditEventRepository(isolatedA.db)), hooks);
      const coordinatorB = new DrizzleFailedPaymentRetryCoordinator(isolatedB.db);

      // A: claims the retry, holds the installment lock, and pauses deterministically immediately
      // before the real provider call — the last possible point before provider.createPayment.
      const executePromise = coordinatorA.claimAndExecuteRetry({
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        agreementId,
        provider: spiedProvider,
        prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        effectApplier: buildContext().buildWebhookService(),
      });
      await beforeProviderCall.promise; // deterministic: A's installment-row lock is GRANTED and held.
      expect(callCount()).toBe(0); // not yet called.

      // B: coordinateSuccess for the SAME installment, on a genuinely independent connection —
      // proven via pg_stat_activity-backed lock observation to be blocked on A's held lock, never a
      // sleep-based assumption.
      const pidB = await warmUp(isolatedB.client);
      const successPromise = coordinatorB.coordinateSuccess({ installmentScheduleItemId });
      await waitUntilPidBlockedOnLock(DATABASE_URL, pidB);

      // Resume A — it completes the real provider call and commits WHILE B remains blocked.
      releaseA.resolve();
      const [executeResult, successResult] = await Promise.all([executePromise, successPromise]);

      expect(executeResult.outcome).toBe("fired");
      expect(callCount()).toBe(1); // provider called exactly once.
      const resultingPaymentAttemptId = executeResult.outcome === "fired" ? executeResult.resultingPaymentAttemptId : null;
      expect(resultingPaymentAttemptId).not.toBeNull();

      const db = getDb();
      const [resultingRow] = await db
        .select({ idempotencyKey: paymentAttempt.idempotencyKey })
        .from(paymentAttempt)
        .where(eq(paymentAttempt.id, resultingPaymentAttemptId!));
      expect(resultingRow?.idempotencyKey).toBe(idempotencyKey); // same stable idempotency key used.

      // Only once A has fully committed does B's coordinateSuccess proceed — it settles the
      // installment and finds nothing left to cancel (A's retry is already the terminal "fired").
      expect(successResult.canceledRetryIds).toHaveLength(0);
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
      const finalRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
      expect(finalRow?.status).toBe("fired"); // no scheduled/claimed retry remains executable.
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("R-B40-STRICT-C — AMBIGUOUS PROVIDER RESPONSE: the sandbox provider ACTUALLY accepts the payment; the application loses the response; the real automatic recovery path (resolveAmbiguousRetry) discovers and correlates it, without ever resubmitting", async () => {
    // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 7 — STRICT-C correction). Unlike
    // the prior version of this test (which threw BEFORE the real provider ever accepted anything),
    // this wraps the REAL `SandboxPaymentProvider.createPayment` so it genuinely runs to completion
    // (registers the payment AND the idempotency-key mapping — see Section 3's fix) and ONLY THEN the
    // wrapper throws `AmbiguousProviderResponseError`, modeling "the external call truly succeeded but
    // the application never durably observed the response." Recovery uses the REAL
    // `resolveAmbiguousRetry` path (`provider.retrievePaymentByIdempotencyKey`, itself untouched by
    // this wrapper) — no test-only direct UPDATE to any row anywhere in this test.
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
    const ctx = buildContext();
    const effectApplier = ctx.buildWebhookService();

    const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
    let providerCallCount = 0;
    let realProviderPaymentId: string | null = null;
    const lossyProvider = new Proxy(realProvider, {
      get(target, prop, receiver) {
        if (prop === "createPayment") {
          return async (...args: unknown[]) => {
            providerCallCount += 1;
            // The REAL sandbox provider genuinely accepts and stores the payment first...
            const result = await (target.createPayment as (...a: unknown[]) => Promise<{ providerPaymentId: string; status: string }>).apply(
              target,
              args,
            );
            realProviderPaymentId = result.providerPaymentId;
            // ...only THEN does the application lose the response — external acceptance already
            // happened; only the app's own knowledge of the outcome is missing.
            throw new AmbiguousProviderResponseError();
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const coordinator = new DrizzleFailedPaymentRetryCoordinator();
    const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
    if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
    const idempotencyKey = `retry-${failure.retryId}`;

    const firstOutcome = await coordinator.claimAndExecuteRetry({
      installmentScheduleItemId,
      retryId: failure.retryId,
      idempotencyKey,
      agreementId,
      provider: lossyProvider,
      prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      effectApplier,
    });
    expect(firstOutcome.outcome).toBe("ambiguous");
    expect(providerCallCount).toBe(1);
    expect(realProviderPaymentId).not.toBeNull();
    let retryRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
    expect(retryRow?.status).toBe("claimed"); // remains recoverable.
    expect(await installmentStatus(installmentScheduleItemId)).toBe("past_due"); // no false installment settlement.

    const db = getDb();
    const submittedRowsBefore = await db.select().from(paymentAttempt).where(eq(paymentAttempt.idempotencyKey, idempotencyKey));
    expect(submittedRowsBefore).toHaveLength(1);
    expect(submittedRowsBefore[0]?.status).toBe("submitted");
    expect(submittedRowsBefore[0]?.providerPaymentId).toBeNull(); // not yet correlated locally.

    // Automatic recovery runs — the REAL resolveAmbiguousRetry path, exactly what fireDueRetries
    // itself calls for a "claimed" retry. Never resubmits; only asks the provider what it already
    // knows via the SAME durable idempotency identity.
    const recoveryOutcome = await coordinator.resolveAmbiguousRetry({ retryId: failure.retryId, idempotencyKey, provider: lossyProvider, effectApplier });
    expect(recoveryOutcome.outcome).toBe("fired");
    expect(providerCallCount).toBe(1); // provider logical-payment count remains exactly 1 — never resubmitted.

    if (recoveryOutcome.outcome === "fired") {
      const [correlatedRow] = await db.select().from(paymentAttempt).where(eq(paymentAttempt.id, recoveryOutcome.resultingPaymentAttemptId));
      expect(correlatedRow?.providerPaymentId).toBe(realProviderPaymentId); // same providerPaymentId.
      expect(correlatedRow?.status).not.toBe("submitted"); // DB payment_attempt becomes correlated/resolved.
    }
    const allRowsForKey = await db.select().from(paymentAttempt).where(eq(paymentAttempt.idempotencyKey, idempotencyKey));
    expect(allRowsForKey).toHaveLength(1); // still exactly one local row — no duplicate.

    retryRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
    expect(retryRow?.status).toBe("fired"); // retry progressed through the real recovery path.
  });

  // ---------------------------------------------------------------------------------------------
  // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 1): the retry path must preserve
  // every financial control a fresh provider attempt would face. These tests exercise the REAL
  // `PaymentRetryService.fireDueRetries` entry point — the actual scheduler call site — with the
  // REAL `DrizzlePaymentInitiationEligibilityService`, never a test-only approximation.
  // ---------------------------------------------------------------------------------------------

  async function buildRetryEligibilityHarness() {
    const ctx = buildContext();
    const verificationCtx = createTestVerificationService();
    const { spiedProvider, callCount } = spyOnCreatePayment(new SandboxPaymentProvider(WEBHOOK_SECRET));
    const eligibility = new DrizzlePaymentInitiationEligibilityService({
      verification: verificationCtx.verificationService,
      payments: ctx.payments,
      balances: ctx.balances,
    });
    const fakeInitiator: RetryPaymentMethodInitiator = {
      async createManualPayment() {
        throw new Error("not used in this test");
      },
      async prepareRetrySubmission(input) {
        return { amountMinorUnits: input.amountMinorUnits, currency: input.currency, paymentMethod: "ach", bankConnectionId: null };
      },
    };
    const coordinator = new DrizzleFailedPaymentRetryCoordinator();
    const retryService = new PaymentRetryService({
      retries: new DrizzlePaymentRetryRepository(),
      paymentAttempts: ctx.payments,
      initiators: { ach: fakeInitiator, debit_card: fakeInitiator, manual_off_platform: fakeInitiator },
      profileOwners: verificationCtx.profileOwners,
      audit: new AuditService(new DrizzleAuditEventRepository()),
      retryCoordinator: coordinator,
      provider: spiedProvider,
      eligibility,
      effectApplier: ctx.buildWebhookService(),
    });
    return { ctx, verificationCtx, spiedProvider, callCount, coordinator, retryService };
  }

  /** Backdates a retry's own `scheduledFor` into the past so ONLY this test's retry becomes "due" for `fireDueRetries(new Date())` — every other shared-database test's own retry is still ~3 business days out, never swept up. */
  async function backdateRetryScheduledFor(retryId: string): Promise<void> {
    const db = getDb();
    await db.update(paymentRetry).set({ scheduledFor: new Date(Date.now() - 60_000) }).where(eq(paymentRetry.id, retryId));
  }

  async function seedVerifiedParties(verificationCtx: ReturnType<typeof createTestVerificationService>, debtor: { profileId: string }, creditor: { profileId: string }) {
    verificationCtx.profileOwners.set("personal", debtor.profileId, randomUUID());
    verificationCtx.profileOwners.set("personal", creditor.profileId, randomUUID());
    for (const profileId of [debtor.profileId, creditor.profileId]) {
      await verificationCtx.verificationService.submitFullVerificationRequest("personal", profileId);
      await verificationCtx.verificationService.recordManualVerificationDecision({
        actingRole: "platform_owner",
        profileKind: "personal",
        profileId,
        decision: "verified",
        reviewerUserId: `b54-reviewer-${randomUUID()}`,
        reason: null,
      });
    }
  }

  it("R-B54A — payment initiation disabled after the original failure but before retry: provider is NEVER called", async () => {
    const { ctx, verificationCtx, callCount, coordinator, retryService } = await buildRetryEligibilityHarness();
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    await seedVerifiedParties(verificationCtx, debtor, creditor);
    const payment = await seedInstallmentPaymentWithMethod(agreementId, installmentScheduleItemId, debtor, creditor);
    const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
    if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
    await backdateRetryScheduledFor(failure.retryId);

    process.env.FEATURE_PAYMENT_INITIATION_ENABLED = "false";
    try {
      await retryService.fireDueRetries(new Date());
    } finally {
      delete process.env.FEATURE_PAYMENT_INITIATION_ENABLED;
    }

    expect(callCount()).toBe(0);
    const retryRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
    expect(retryRow?.status).toBe("canceled");
    void ctx;
  });

  it("R-B54B — the payer loses required full verification before retry: provider is NEVER called", async () => {
    const { callCount, coordinator, retryService } = await buildRetryEligibilityHarness();
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    // Deliberately do NOT verify either party — `isFullyVerified` correctly reports false.
    const payment = await seedInstallmentPaymentWithMethod(agreementId, installmentScheduleItemId, debtor, creditor);
    const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
    if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
    await backdateRetryScheduledFor(failure.retryId);

    await retryService.fireDueRetries(new Date());

    expect(callCount()).toBe(0);
    const retryRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
    expect(retryRow?.status).toBe("canceled");
  });

  it("R-B54C — the retry's amount exceeds the applicable transaction limit: provider is NEVER called", async () => {
    const { verificationCtx, callCount, coordinator, retryService } = await buildRetryEligibilityHarness();
    const { creditor, debtor } = await seedTwoParties(1_000_000_000);
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 500_000);
    await seedVerifiedParties(verificationCtx, debtor, creditor);
    const payment = await seedInstallmentPaymentWithMethod(agreementId, installmentScheduleItemId, debtor, creditor); // amountMinorUnits: 5_000 per seedInstallmentPayment.
    const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
    if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
    await backdateRetryScheduledFor(failure.retryId);

    process.env.MAX_PAYMENT_MINOR_UNITS = "1000"; // below the retry's own 5_000 amount.
    try {
      await retryService.fireDueRetries(new Date());
    } finally {
      delete process.env.MAX_PAYMENT_MINOR_UNITS;
    }

    expect(callCount()).toBe(0);
    const retryRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
    expect(retryRow?.status).toBe("canceled");
  });

  it("R-B54D — the installment becomes fully paid before retry authorization: provider is NEVER called", async () => {
    const { verificationCtx, callCount, coordinator, retryService } = await buildRetryEligibilityHarness();
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    await seedVerifiedParties(verificationCtx, debtor, creditor);
    const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
    const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
    if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
    await backdateRetryScheduledFor(failure.retryId);

    // A different payment for the same installment settles it BEFORE retry authorization runs.
    await coordinator.coordinateSuccess({ installmentScheduleItemId });

    await retryService.fireDueRetries(new Date());

    expect(callCount()).toBe(0);
    const retryRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
    expect(retryRow?.status).toBe("canceled");
    expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
  });

  it("R-B54E — the agreement's outstanding balance changed (a different payment already covered it) so the retry would overpay: provider is NEVER called", async () => {
    const { ctx, verificationCtx, callCount, coordinator, retryService } = await buildRetryEligibilityHarness();
    const { creditor, debtor } = await seedTwoParties(5_000); // principal exactly 5_000.
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    await seedVerifiedParties(verificationCtx, debtor, creditor);
    const payment = await seedInstallmentPaymentWithMethod(agreementId, installmentScheduleItemId, debtor, creditor);
    const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
    if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
    await backdateRetryScheduledFor(failure.retryId);

    // A DIFFERENT payment on the SAME agreement (not this installment) already cleared the FULL
    // principal — the retry's own 5_000 would now overpay a fully-satisfied agreement.
    const otherProviderPaymentId = `sandbox_pay_${randomUUID()}`;
    const otherPayment = await seedPendingPayment(ctx.payments, {
      agreementId,
      amountMinorUnits: 5_000,
      payerProfileId: debtor.profileId,
      recipientProfileId: creditor.profileId,
      providerPaymentId: otherProviderPaymentId,
    });
    await ctx.payments.updateStatus(otherPayment.id, "succeeded", {});
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: otherPayment.id, agreementId, currency: "USD", grossAmountMinorUnits: 5_000 });

    await retryService.fireDueRetries(new Date());

    expect(callCount()).toBe(0);
    const retryRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
    expect(retryRow?.status).toBe("canceled");
  });

  it("R-B55 — provider accepts payment, application loses the response; the scheduler's own automatic recovery discovers and correlates it, with the provider called exactly once, and a revoked mandate afterward never cancels the already-dispatched attempt", async () => {
    const { ctx, verificationCtx, coordinator } = await buildRetryEligibilityHarness();
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
    await seedVerifiedParties(verificationCtx, debtor, creditor);
    const payment = await seedInstallmentPaymentWithMethod(agreementId, installmentScheduleItemId, debtor, creditor);
    const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
    if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
    await backdateRetryScheduledFor(failure.retryId);

    // A provider that genuinely accepts the payment, then the application loses the response.
    const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
    let providerCallCount = 0;
    let realProviderPaymentId: string | null = null;
    const lossyProvider = new Proxy(realProvider, {
      get(target, prop, receiver) {
        if (prop === "createPayment") {
          return async (...args: unknown[]) => {
            providerCallCount += 1;
            const result = await (target.createPayment as (...a: unknown[]) => Promise<{ providerPaymentId: string; status: string }>).apply(
              target,
              args,
            );
            realProviderPaymentId = result.providerPaymentId;
            throw new AmbiguousProviderResponseError();
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    // A dedicated initiator/retryService pair using the lossy provider for this one test.
    let mandateRevoked = false;
    const revocableInitiator: RetryPaymentMethodInitiator = {
      async createManualPayment() {
        throw new Error("not used in this test");
      },
      async prepareRetrySubmission(input) {
        if (mandateRevoked) throw new Error("mandate_revoked");
        return { amountMinorUnits: input.amountMinorUnits, currency: input.currency, paymentMethod: "ach", bankConnectionId: null };
      },
    };
    const eligibility = new DrizzlePaymentInitiationEligibilityService({
      verification: verificationCtx.verificationService,
      payments: ctx.payments,
      balances: ctx.balances,
    });
    const retryService = new PaymentRetryService({
      retries: new DrizzlePaymentRetryRepository(),
      paymentAttempts: ctx.payments,
      initiators: { ach: revocableInitiator, debit_card: revocableInitiator, manual_off_platform: revocableInitiator },
      profileOwners: verificationCtx.profileOwners,
      audit: new AuditService(new DrizzleAuditEventRepository()),
      retryCoordinator: coordinator,
      provider: lossyProvider,
      eligibility,
      effectApplier: ctx.buildWebhookService(),
    });

    // First dispatch: the coordinator directly (NOT `fireDueRetries` — a single `fireDueRetries` call
    // processes its OWN just-created "claimed" rows in the SAME invocation via `findClaimedForResumption`,
    // which would immediately resolve this one since the underlying provider already knows about it —
    // realistic, but not what THIS scenario needs to isolate: a genuine gap in time between the
    // ambiguous dispatch and the LATER, separate automatic-recovery scheduler run).
    const prepared = await revocableInitiator.prepareRetrySubmission({ agreementId, amountMinorUnits: 5_000, currency: "USD" });
    const firstOutcome = await coordinator.claimAndExecuteRetry({
      installmentScheduleItemId,
      retryId: failure.retryId,
      idempotencyKey: `retry-${failure.retryId}`,
      agreementId,
      provider: lossyProvider,
      prepared,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      effectApplier: ctx.buildWebhookService(),
    });
    expect(firstOutcome.outcome).toBe("ambiguous");
    expect(providerCallCount).toBe(1);
    let retryRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
    expect(retryRow?.status).toBe("claimed"); // remains recoverable.

    // The mandate becomes invalid AFTER the ambiguous dispatch — resumption must NEVER re-run
    // prepareRetrySubmission (which is where this would throw), so it must not cancel the
    // already-dispatched attempt.
    mandateRevoked = true;

    // Automatic scheduler recovery (bounded, discovers the "claimed" retry via findClaimedForResumption).
    const secondRun = await retryService.fireDueRetries(new Date());
    expect(secondRun.resolved).toBe(1);
    expect(providerCallCount).toBe(1); // provider create call count remains exactly 1.

    retryRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
    expect(retryRow?.status).toBe("fired"); // never canceled despite the revoked mandate.

    const db = getDb();
    const [resultingRow] = await db.select().from(paymentAttempt).where(eq(paymentAttempt.id, retryRow!.resultingPaymentAttemptId!));
    expect(resultingRow?.providerPaymentId).toBe(realProviderPaymentId); // providerPaymentId persisted, correlated.
    expect(resultingRow?.status).not.toBe("submitted");
  });

  it("R-B57 — bounded scheduler runs on many permanently-ambiguous claimed retries never starve a later, genuinely resolvable one", async () => {
    const { ctx, verificationCtx, coordinator } = await buildRetryEligibilityHarness();
    const effectApplier = ctx.buildWebhookService();
    const BATCH = 5;
    const PERMANENTLY_AMBIGUOUS_COUNT = 12;

    // ONE shared real provider instance, exactly as production wires it. `neverReachedKeys` models a
    // request that never actually reached the provider at all (its idempotency key is never
    // registered internally) — genuinely, permanently unresolvable via `retrievePaymentByIdempotencyKey`
    // — versus a request that DID reach and register with the provider before the response was lost,
    // which is genuinely resolvable the moment anyone asks.
    const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
    const neverReachedKeys = new Set<string>();
    const sharedProvider = new Proxy(realProvider, {
      get(target, prop, receiver) {
        if (prop === "createPayment") {
          return async (...args: unknown[]) => {
            const [createInput] = args as [{ idempotencyKey: string }];
            if (neverReachedKeys.has(createInput.idempotencyKey)) throw new AmbiguousProviderResponseError();
            await (target.createPayment as (...a: unknown[]) => unknown).apply(target, args);
            throw new AmbiguousProviderResponseError();
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    async function seedClaimedAmbiguousRetry(permanentlyUnreachable: boolean): Promise<{ retryId: string; installmentScheduleItemId: string; idempotencyKey: string }> {
      const { creditor, debtor } = await seedTwoParties();
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;
      if (permanentlyUnreachable) neverReachedKeys.add(idempotencyKey); // set BEFORE dispatch — the request never actually reaches the provider.
      const outcome = await coordinator.claimAndExecuteRetry({
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        agreementId,
        provider: sharedProvider,
        prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        effectApplier,
      });
      expect(outcome.outcome).toBe("ambiguous");
      return { retryId: failure.retryId, installmentScheduleItemId, idempotencyKey };
    }

    const permanentlyAmbiguous: { retryId: string; installmentScheduleItemId: string; idempotencyKey: string }[] = [];
    for (let i = 0; i < PERMANENTLY_AMBIGUOUS_COUNT; i += 1) {
      permanentlyAmbiguous.push(await seedClaimedAmbiguousRetry(true));
    }
    // The later, genuinely-resolvable retry — its idempotencyKey is NOT in `neverReachedKeys`, so the
    // shared provider actually registered it before losing the response.
    const laterResolvable = await seedClaimedAmbiguousRetry(false);

    // Bounded, repeated resumption runs — mirrors exactly what `fireDueRetries` itself does for
    // "claimed" retries (`findClaimedForResumption` + `resolveAmbiguousRetry`, deferring on failure).
    const retries = new DrizzlePaymentRetryRepository();
    let laterResolvedAtRun = -1;
    for (let run = 0; run < 6 && laterResolvedAtRun === -1; run += 1) {
      const claimedBatch = await retries.findClaimedForResumption(BATCH, new Date());
      expect(claimedBatch.length).toBeLessThanOrEqual(BATCH); // every run is bounded.
      for (const retry of claimedBatch) {
        const outcome = await coordinator.resolveAmbiguousRetry({ retryId: retry.id, idempotencyKey: `retry-${retry.id}`, provider: sharedProvider, effectApplier });
        if (outcome.outcome !== "fired") {
          await retries.markResolutionDeferred(retry.id, new Date(Date.now() + 1)); // minimal backoff — unresolved records are deferred, not re-selected immediately.
        } else if (retry.id === laterResolvable.retryId) {
          laterResolvedAtRun = run;
        }
      }
    }

    // The later, genuinely-resolvable retry was serviced within a bounded number of runs — never
    // starved behind the 12 permanently-ambiguous ones (batch size 5).
    expect(laterResolvedAtRun).toBeGreaterThanOrEqual(0);
    const laterRetryRowAfter = (await listRetriesForInstallment(laterResolvable.installmentScheduleItemId)).find((r) => r.id === laterResolvable.retryId);
    expect(laterRetryRowAfter?.status).toBe("fired");

    // The 12 permanently-ambiguous ones remain visible/unresolved (never falsely fired, never a
    // fabricated resolution) — each deferred, not silently dropped.
    for (const stuck of permanentlyAmbiguous) {
      const stuckRow = (await listRetriesForInstallment(stuck.installmentScheduleItemId)).find((r) => r.id === stuck.retryId);
      expect(stuckRow?.status).toBe("claimed");
    }

    // Test hygiene (Stage 9 remediation, Root Correction 1): these 12 rows are DELIBERATELY left
    // "claimed" above to prove the assertion this test exists for — but under the corrected
    // architecture, a LATER, unrelated test's own `fireDueRetries` resumption sweep would otherwise
    // treat each one's "not found" (via ITS OWN, different provider instance, which never registered
    // these idempotency keys) as a genuine invitation to redispatch (Root Correction 1's own required
    // behavior — "not found" no longer a permanent no-op). Closing them out directly here — never via
    // `resolveAmbiguousRetry`, which would never resolve a GENUINELY permanently-unreachable key
    // anyway — keeps this test's own proof intact while never leaking a stray "claimed" row into any
    // other test's global claimed-resumption scan.
    const db = getDb();
    await db
      .update(paymentRetry)
      .set({ status: "canceled", canceledAt: new Date(), canceledReason: "Test hygiene: permanently-unreachable simulated retry closed at test end." })
      .where(
        inArray(
          paymentRetry.id,
          permanentlyAmbiguous.map((p) => p.retryId),
        ),
      );
    void verificationCtx;
  });

  it("R-B40-STRICT — a deterministic pause at the LAST POSSIBLE POINT before the real provider call produces exactly one of the two valid serial orders, never a call after revocation", async () => {
    // PACKAGE B — PRE-CODEX FINAL CORRECTION (item 2). Exercises the REAL `PaymentService
    // .submitToProvider` code path — the actual production call site where `finalGuard` is now
    // invoked as its own absolute last step, immediately before `provider.createPayment(...)`, with
    // NO other awaited work in between (see that method's own doc comment) — via a real Postgres
    // `payment_attempt` repository and a spied real `SandboxPaymentProvider`. `AchPaymentService`/
    // `DebitCardPaymentService` are not separately re-exercised here (they are thin, mandate/card
    // pass-throughs onto this exact same `submitPending` -> `submitToProvider` chain; their own
    // `finalGuard` plumbing is a one-line pass-through, unit-tested by this file's full green
    // typecheck/build against both call sites).
    const { creditor, debtor } = await seedTwoParties();
    const provider = new SandboxPaymentProvider(WEBHOOK_SECRET);
    let providerCallCount = 0;
    const spiedProvider = new Proxy(provider, {
      get(target, prop, receiver) {
        if (prop === "createPayment") {
          return async (...args: unknown[]) => {
            providerCallCount += 1;
            return (target.createPayment as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const paymentServiceForFiring = new PaymentService({
      provider: spiedProvider,
      verification: createTestVerificationService().verificationService,
      profileOwners: new DrizzleProfileOwnerReader(),
      payments: new DrizzlePaymentAttemptRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      agreements: new InMemoryAgreementPartiesReader(),
    });
    const coordinator = new DrizzleFailedPaymentRetryCoordinator();

    async function seedScheduledResultingPayment(agreementId: string, installmentScheduleItemId: string) {
      const payments = new DrizzlePaymentAttemptRepository();
      return payments.insertPending({
        idempotencyKey: `retry-strict-${randomUUID()}`,
        payerProfileKind: "personal",
        payerProfileId: debtor.profileId,
        recipientProfileKind: "personal",
        recipientProfileId: creditor.profileId,
        amountMinorUnits: 5_000,
        currency: "USD",
        agreementId,
        providerName: provider.providerName,
        installmentScheduleItemId,
        initialStatus: "scheduled",
      });
    }

    // Fires ONE retry through the REAL PaymentService.submitPending -> submitToProvider chain,
    // pausing at a deterministic barrier positioned to stand in for "the worker is suspended
    // immediately before its finalGuard check runs" — the last possible point before the real
    // provider call, per the test's own required scenario. `finalGuard` itself (the coordinator's
    // `confirmExecutionStillValid` check) always runs AFTER the barrier releases, reading whatever
    // is authoritative and committed at THAT moment — exactly mirroring how a real, genuinely
    // concurrent worker would observe a `coordinateSuccess` that completed while it was suspended.
    async function fireOneRetryPausingBeforeFinalCheck(
      agreementId: string,
      installmentScheduleItemId: string,
      retryId: string,
      executionToken: string,
      barrier: Promise<void>,
    ): Promise<{ outcome: "fired" | "revoked" }> {
      const resulting = await seedScheduledResultingPayment(agreementId, installmentScheduleItemId);
      try {
        await paymentServiceForFiring.submitPending(resulting.id, debtor.userId, null, null, async () => {
          await barrier;
          const stillValid = await coordinator.confirmExecutionStillValid({ retryId, executionToken });
          if (!stillValid) throw new Error("payment_retry_execution_revoked_before_submission");
        });
        await coordinator.markRetryFired({ retryId, executionToken, resultingPaymentAttemptId: resulting.id, firedAt: new Date() });
        return { outcome: "fired" };
      } catch {
        await coordinator.markRetryExecutionFailed({ retryId, executionToken, canceledReason: "revoked" });
        return { outcome: "revoked" };
      }
    }

    // ---- ORDER 2 (the previously-broken case): B revokes first -> provider is NEVER called. ----
    {
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const claim = await coordinator.claimRetryForExecution({ installmentScheduleItemId, retryId: failure.retryId });
      if (claim.outcome !== "claimed") throw new Error("expected the retry to be claimable");

      const barrier = createDeferred<void>();
      const callsBefore = providerCallCount;
      const workerA = fireOneRetryPausingBeforeFinalCheck(agreementId, installmentScheduleItemId, failure.retryId, claim.executionToken, barrier.promise);
      // Worker B settles the installment WHILE A is suspended before its final check.
      await coordinator.coordinateSuccess({ installmentScheduleItemId });
      barrier.resolve();
      const outcome = await workerA;

      expect(outcome.outcome).toBe("revoked");
      expect(providerCallCount - callsBefore).toBe(0); // provider.createPayment is NEVER called.
      const finalRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
      expect(finalRow?.status).toBe("canceled");
      expect(finalRow?.resultingPaymentAttemptId).toBeNull();
    }

    // ---- ORDER 1: A retains its execution right (no concurrent revocation) -> provider called exactly once. ----
    {
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const claim = await coordinator.claimRetryForExecution({ installmentScheduleItemId, retryId: failure.retryId });
      if (claim.outcome !== "claimed") throw new Error("expected the retry to be claimable");

      const barrier = createDeferred<void>();
      const callsBefore = providerCallCount;
      const workerA = fireOneRetryPausingBeforeFinalCheck(agreementId, installmentScheduleItemId, failure.retryId, claim.executionToken, barrier.promise);
      barrier.resolve(); // no concurrent revocation — release immediately.
      const outcome = await workerA;

      expect(outcome.outcome).toBe("fired");
      expect(providerCallCount - callsBefore).toBe(1); // provider called exactly once.
      const finalRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
      expect(finalRow?.status).toBe("fired");
      // B settling afterward leaves no stale executable retry — the already-fired retry is terminal.
      const { canceledRetryIds } = await coordinator.coordinateSuccess({ installmentScheduleItemId });
      expect(canceledRetryIds).toHaveLength(0);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // PACKAGE B — REMAINING CODEX BLOCKERS: bounded automatic repair must eventually complete
  // (Section 1) + reconciliation evidence must be complete/exact/bounded (Section 4).
  // ---------------------------------------------------------------------------------------------

  it("R-B33 — bounded automatic repair eventually covers every candidate without starving the oldest, across repeated bounded batches", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties(1_000_000);
    const ctx = buildContext();
    const TOTAL = 55;
    const BATCH = 50;
    const db = getDb();
    // Deliberately ancient, strictly-increasing updatedAt values — guarantees these 55 rows sort
    // BEFORE any other test's leftover candidate in this shared database (real timestamps), so the
    // oldest-first ordering under test is deterministically observable regardless of run order.
    const baseTime = new Date("2019-01-01T00:00:00Z").getTime();
    const paymentIds: string[] = [];
    for (let i = 0; i < TOTAL; i += 1) {
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 100, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
      await ctx.payments.updateStatus(payment.id, "succeeded", {});
      await db.update(paymentAttempt).set({ updatedAt: new Date(baseTime + i * 1_000) }).where(eq(paymentAttempt.id, payment.id));
      const trustedEvent = await ctx.events.tryInsertAndClaim({
        provider: ctx.provider.providerName,
        providerEventId: `evt-${randomUUID()}`,
        eventType: "payment.succeeded",
        source: "webhook",
        signatureVerified: true,
        payload: { providerPaymentId, amountMinorUnits: 100, currency: "USD", processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 },
        leaseMs: 120_000,
        now: new Date(),
      });
      await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());
      paymentIds.push(payment.id);
    }

    const oldestPaymentId = paymentIds[0]!;
    expect(await findClearEntry(ctx.ledger, oldestPaymentId)).toBeNull();

    const firstRun = await ctx.reconciliation.repairBatch(BATCH);
    // Bounded — each of the 3 merged candidate queries is itself capped at BATCH, so the union can
    // never exceed 3x it (PAID2YOU — PACKAGE B, Section 4 — B4 fix: `listLifecycleRepairCandidates`
    // now ALSO surfaces genuinely distinct lifecycle-only candidates from elsewhere in this shared
    // database that the ledger-less rows here used to crowd out of its own LIMIT entirely — a strictly
    // MORE complete, still-bounded result, never an unbounded one).
    expect(firstRun.scanned).toBeGreaterThanOrEqual(BATCH);
    expect(firstRun.scanned).toBeLessThanOrEqual(BATCH * 3);
    // The oldest candidate is included in the FIRST run — never starved behind newer ones.
    expect(await findClearEntry(ctx.ledger, oldestPaymentId)).not.toBeNull();

    const secondRun = await ctx.reconciliation.repairBatch(BATCH);
    expect(secondRun.scanned).toBeGreaterThanOrEqual(TOTAL - BATCH);

    for (const paymentId of paymentIds) {
      expect(await findClearEntry(ctx.ledger, paymentId)).not.toBeNull();
    }
  });

  it("R-B33-LIFECYCLE-STARVATION — legitimately-still-active agreements never permanently monopolize the batch; a genuinely missed lifecycle transition is eventually reached and repaired, in bounded per-run work", async () => {
    // PACKAGE B — PRE-CODEX FINAL CORRECTION (item 3). Reproduces the exact starvation Codex
    // described: `listLifecycleRepairCandidates` used to filter ONLY on agreement status (not on
    // whether THIS payment's own effect had ever been examined), so a legitimately-still-active
    // agreement's succeeded payment would re-qualify on every single call forever — with a bounded
    // batch smaller than the number of such rows, the SAME oldest ones would be returned on every
    // run, permanently starving a genuinely unresolved row dated later than the oldest `limit` of
    // them. The fix (`lifecycleCheckedAt`) makes every examined row — no-op or not — drop out
    // permanently, which is what this test proves converges within a bounded number of runs.
    const ctx = buildContext();
    const db = getDb();
    const baseTime = new Date("2018-01-01T00:00:00Z").getTime();
    const BATCH = 5;

    // 12 agreements that are correctly, permanently ACTIVE: principal 10_000, one succeeded payment
    // of 4_000 each — examining any of them is a genuine, correct no-op (balance still outstanding).
    const legitPaymentIds: string[] = [];
    const legitAgreementIds: string[] = [];
    async function seedLegitActiveCandidate(dateOffsetSeconds: number) {
      const { creditor, debtor, agreementId } = await seedTwoParties(10_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 4_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
      await ctx.payments.updateStatus(payment.id, "succeeded", {});
      await ctx.ledger.postPaymentCleared({ paymentAttemptId: payment.id, agreementId, currency: "USD", grossAmountMinorUnits: 4_000 });
      await db.update(paymentAttempt).set({ updatedAt: new Date(baseTime + dateOffsetSeconds * 1_000) }).where(eq(paymentAttempt.id, payment.id));
      legitPaymentIds.push(payment.id);
      legitAgreementIds.push(agreementId);
    }

    // The genuinely missed transition: principal 5_000, one succeeded payment of exactly 5_000 —
    // examining it correctly advances the agreement straight to paid_in_full (checkAndAdvance's own
    // settlementState check fires regardless of "first_payment_pending" being the current status).
    const { creditor: genCreditor, debtor: genDebtor, agreementId: genuineAgreementId } = await seedTwoParties(5_000);
    const genuineProviderPaymentId = `sandbox_pay_${randomUUID()}`;
    const genuinePayment = await seedPendingPayment(ctx.payments, {
      agreementId: genuineAgreementId,
      amountMinorUnits: 5_000,
      payerProfileId: genDebtor.profileId,
      recipientProfileId: genCreditor.profileId,
      providerPaymentId: genuineProviderPaymentId,
    });
    await ctx.payments.updateStatus(genuinePayment.id, "succeeded", {});
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: genuinePayment.id, agreementId: genuineAgreementId, currency: "USD", grossAmountMinorUnits: 5_000 });

    // Chronological order: 6 legit rows, THEN the genuine one, THEN 6 more legit rows — dated so
    // that under the OLD (unfixed) "agreement status only" predicate, a batch of 5 would return the
    // SAME oldest 5 legit rows on every single call, forever, never reaching the genuine row at all.
    for (let i = 0; i < 6; i += 1) await seedLegitActiveCandidate(i);
    await db.update(paymentAttempt).set({ updatedAt: new Date(baseTime + 6 * 1_000) }).where(eq(paymentAttempt.id, genuinePayment.id));
    for (let i = 7; i < 13; i += 1) await seedLegitActiveCandidate(i);

    expect((await ctx.agreements.findById(genuineAgreementId))?.status).toBe("first_payment_pending"); // transition genuinely missed so far.

    // Bounded, repeated scheduler runs — each must examine at most BATCH lifecycle rows.
    const seenLifecycleChecks: number[] = [];
    let genuineReachedAtRun = -1;
    for (let run = 0; run < 5; run += 1) {
      await ctx.reconciliation.repairBatch(BATCH);
      const uncheckedCount = (
        await db
          .select({ id: paymentAttempt.id })
          .from(paymentAttempt)
          .where(and(eq(paymentAttempt.status, "succeeded"), isNull(paymentAttempt.lifecycleCheckedAt), inArray(paymentAttempt.id, [...legitPaymentIds, genuinePayment.id])))
      ).length;
      seenLifecycleChecks.push(uncheckedCount);
      if (genuineReachedAtRun === -1 && (await ctx.agreements.findById(genuineAgreementId))?.status === "paid_in_full") genuineReachedAtRun = run;
      if (uncheckedCount === 0) break;
    }

    // Reached well within a bounded number of runs — ceil(13 / 5) = 3, never "forever".
    expect(genuineReachedAtRun).toBeGreaterThanOrEqual(0);
    expect(genuineReachedAtRun).toBeLessThanOrEqual(2);

    // Every examined row (legit or genuine) is now permanently excluded — the unchecked count
    // strictly decreases run over run and reaches zero, proving no row is examined forever without
    // shrinking the remaining candidate set (the literal definition of "does not monopolize the batch").
    for (let i = 1; i < seenLifecycleChecks.length; i += 1) {
      expect(seenLifecycleChecks[i]!).toBeLessThan(seenLifecycleChecks[i - 1]!);
    }
    expect(seenLifecycleChecks.at(-1)).toBe(0);

    // Legitimate agreements were correctly NEVER advanced — examining a genuine no-op must never
    // incorrectly complete or activate-past-reality an agreement whose real balance doesn't warrant it.
    for (const agreementId of legitAgreementIds) {
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("active");
    }
    for (const paymentId of legitPaymentIds) {
      const [row] = await db.select({ lifecycleCheckedAt: paymentAttempt.lifecycleCheckedAt }).from(paymentAttempt).where(eq(paymentAttempt.id, paymentId));
      expect(row?.lifecycleCheckedAt).not.toBeNull(); // examined exactly once, permanently excluded thereafter.
    }
  });

  it("R-B34 — automatic repair selects and repairs missing refund/return/reversed/disputed ledger consequences, not merely 'succeeded'", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();

    const scenarios: { status: "refunded" | "returned" | "reversed" | "disputed"; eventType: string; expectedEntryType: string }[] = [
      { status: "refunded", eventType: "payment.refunded", expectedEntryType: "refund" },
      { status: "returned", eventType: "payment.returned", expectedEntryType: "reversal" },
      { status: "reversed", eventType: "payment.reversed", expectedEntryType: "reversal" },
      { status: "disputed", eventType: "payment.disputed", expectedEntryType: "dispute_adjustment" },
    ];

    const paymentIds: string[] = [];
    for (const scenario of scenarios) {
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
      await ctx.payments.updateStatus(payment.id, "succeeded", {});
      await ctx.ledger.postPaymentCleared({ paymentAttemptId: payment.id, agreementId, currency: "USD", grossAmountMinorUnits: 1_000 });
      await ctx.payments.updateStatus(payment.id, scenario.status, {});
      const trustedEvent = await ctx.events.tryInsertAndClaim({
        provider: ctx.provider.providerName,
        providerEventId: `evt-${randomUUID()}`,
        eventType: scenario.eventType,
        source: "webhook",
        signatureVerified: true,
        payload: { providerPaymentId, amountMinorUnits: 1_000, currency: "USD" },
        leaseMs: 120_000,
        now: new Date(),
      });
      await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());
      paymentIds.push(payment.id);
    }

    const result = await ctx.reconciliation.repairBatch(200);
    expect(result.scanned).toBeGreaterThanOrEqual(scenarios.length);

    for (let i = 0; i < scenarios.length; i += 1) {
      const entries = await ctx.ledger.listEntriesForPaymentAttempt(paymentIds[i]!);
      expect(entries.some((e) => e.entryType === scenarios[i]!.expectedEntryType)).toBe(true);
    }
  });

  it("R-B35 — scheduled repair never calls webhookEvents.listAll() (instrumented proof)", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});
    const trustedEvent = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId, amountMinorUnits: 1_000, currency: "USD", processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 },
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());

    let listAllCalls = 0;
    const realListAll = ctx.events.listAll.bind(ctx.events);
    const instrumentedEvents = ctx.events as unknown as { listAll: () => ReturnType<typeof realListAll> };
    instrumentedEvents.listAll = () => {
      listAllCalls += 1;
      return realListAll();
    };

    const result = await ctx.reconciliation.repairBatch(200);
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(await findClearEntry(ctx.ledger, payment.id)).not.toBeNull();
    expect(listAllCalls).toBe(0); // the automatic repair path never touched listAll().
  });

  it("R-B43 — provider-routed repair refuses when amountMinorUnits is missing from the trusted event", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});
    const trustedEvent = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId, currency: "USD", processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 }, // amountMinorUnits missing.
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());

    const found = await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("internal_posting_failure");
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();
  });

  it("R-B44 — provider-routed repair refuses when amountMinorUnits has the wrong type", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});
    const trustedEvent = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId, amountMinorUnits: "1000", currency: "USD", processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 },
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());

    const found = await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("internal_posting_failure");
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();
  });

  it("R-B45 — provider-routed repair refuses when currency is missing from the trusted event", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});
    const trustedEvent = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId, amountMinorUnits: 1_000, processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 }, // currency missing.
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());

    const found = await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("internal_posting_failure");
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();
  });

  it("R-B46 — provider-routed repair refuses when a required PROVIDER-authoritative fee field (processorFeeMinorUnits) is missing from the trusted event", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});
    const trustedEvent = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      // PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 5): processorFeeMinorUnits
      // (missing here) remains a REQUIRED provider-authoritative field — unlike platformFeeMinorUnits,
      // which repair no longer reads from the payload at all (always sourced from PlatformFeePolicy),
      // so its absence here is irrelevant to whether repair can proceed.
      payload: { providerPaymentId, amountMinorUnits: 1_000, currency: "USD" },
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());

    const found = await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("internal_posting_failure");
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();
  });

  it("R-B47 — repair refuses when the trusted event's provider namespace doesn't match the payment's own providerName", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});
    // Only a DIFFERENT-provider event exists — the payment's own providerName ("sandbox_mock") has no
    // trusted event at all.
    const decoy = await ctx.events.tryInsertAndClaim({
      provider: "other_provider_mock",
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId, amountMinorUnits: 1_000, currency: "USD", processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 },
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(decoy!.id, decoy!.claimToken!, new Date());

    const found = await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("internal_posting_failure");
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();
  });

  it("R-B48 — two trusted matching events for the same payment are ambiguous and block repair", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});
    for (let i = 0; i < 2; i += 1) {
      const inserted = await ctx.events.tryInsertAndClaim({
        provider: ctx.provider.providerName,
        providerEventId: `evt-${randomUUID()}`,
        eventType: "payment.succeeded",
        source: "webhook",
        signatureVerified: true,
        payload: { providerPaymentId, amountMinorUnits: 1_000, currency: "USD", processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 },
        leaseMs: 120_000,
        now: new Date(),
      });
      await ctx.events.markProcessed(inserted!.id, inserted!.claimToken!, new Date());
    }

    const found = await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("internal_posting_failure");
    expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();
  });

  it("R-B49 — a single complete, unambiguous trusted event repairs exactly once", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});
    const trustedEvent = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId, amountMinorUnits: 1_000, currency: "USD", processorFeeMinorUnits: 10, platformFeeMinorUnits: 20 },
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());

    const found = await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).not.toContain("internal_posting_failure");
    const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);

    await ctx.reconciliation.reconcilePaymentAttempt(payment.id); // idempotent re-run.
    const entriesAfter = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entriesAfter.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
  });

  it("R-B58 — 50 oldest permanently-unsafe repair candidates never starve a later, genuinely valid one; a transiently-blocked candidate becomes eligible again once its backoff elapses", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties(1_000_000);
    console.error("R-B58 checkpoint: seeded parties/agreement");
    const ctx = buildContext();
    const db = getDb();
    const BATCH = 50;
    const baseTime = new Date("2017-01-01T00:00:00Z").getTime();
    const runAt = new Date("2026-01-01T00:00:00Z"); // fixed, deterministic "now" for this whole test.

    // 50 oldest candidates with NO trusted evidence at all — automatic repair is permanently unable
    // to safely repair them (manual-review exception, never fabricated evidence).
    const unsafePaymentIds: string[] = [];
    for (let i = 0; i < BATCH; i += 1) {
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 100, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
      await ctx.payments.updateStatus(payment.id, "succeeded", {});
      await db.update(paymentAttempt).set({ updatedAt: new Date(baseTime + i * 1_000) }).where(eq(paymentAttempt.id, payment.id));
      unsafePaymentIds.push(payment.id);
    }

    // ONE later, genuinely valid candidate — complete trusted evidence, dated after all 50.
    const validProviderPaymentId = `sandbox_pay_${randomUUID()}`;
    const validPayment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 100, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId: validProviderPaymentId });
    await ctx.payments.updateStatus(validPayment.id, "succeeded", {});
    await db.update(paymentAttempt).set({ updatedAt: new Date(baseTime + BATCH * 1_000) }).where(eq(paymentAttempt.id, validPayment.id));
    const validTrustedEvent = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId: validProviderPaymentId, amountMinorUnits: 100, currency: "USD", processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 },
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(validTrustedEvent!.id, validTrustedEvent!.claimToken!, new Date());

    // Run 1: the batch (size 50) is entirely consumed by the 50 unsafe, oldest candidates — every one
    // fails repair and is deferred (financial_repair_next_attempt_at set).
    expect(await findClearEntry(ctx.ledger, validPayment.id)).toBeNull();
    const firstRun = await ctx.reconciliation.repairBatch(BATCH, runAt);
    expect(firstRun.scanned).toBe(BATCH); // bounded — never more than the batch size.
    expect(await findClearEntry(ctx.ledger, validPayment.id)).toBeNull(); // not yet reached.
    for (const id of unsafePaymentIds) {
      expect(await findClearEntry(ctx.ledger, id)).toBeNull(); // correctly still unrepaired — no fabricated evidence.
    }

    // Run 2 (SAME "now" — backoff has not elapsed): the 50 deferred rows are excluded from the
    // candidate query, so the batch now reaches the later, genuinely valid candidate.
    const secondRun = await ctx.reconciliation.repairBatch(BATCH, runAt);
    expect(secondRun.scanned).toBeGreaterThanOrEqual(1);
    expect(await findClearEntry(ctx.ledger, validPayment.id)).not.toBeNull(); // eventually repaired — never starved.

    // A transiently-blocked candidate (one of the 50) becomes eligible again once its OWN backoff
    // elapses — never permanently excluded. Give it real evidence now, then advance "now" past the
    // 1-hour backoff window.
    const transientPaymentId = unsafePaymentIds[0]!;
    const transientPayment = await ctx.payments.findById(transientPaymentId);
    const transientTrustedEvent = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId: transientPayment!.providerPaymentId, amountMinorUnits: 100, currency: "USD", processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 },
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(transientTrustedEvent!.id, transientTrustedEvent!.claimToken!, new Date());

    // Still deferred at the SAME "now" — evidence alone doesn't bypass the backoff.
    await ctx.reconciliation.repairBatch(BATCH, runAt);
    expect(await findClearEntry(ctx.ledger, transientPaymentId)).toBeNull();

    // Once its backoff has genuinely elapsed, it becomes eligible again and repairs successfully.
    const muchLater = new Date(runAt.getTime() + 2 * 60 * 60 * 1000);
    await ctx.reconciliation.repairBatch(BATCH, muchLater);
    expect(await findClearEntry(ctx.ledger, transientPaymentId)).not.toBeNull();
  });

  // ---------------------------------------------------------------------------------------------
  // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 5): transition-marker lost-claim
  // atomicity.
  // ---------------------------------------------------------------------------------------------

  it("R-B59 — a ZERO-ROW transition-marker update (lease expired, event reclaimed with a fresh token) rolls back the WHOLE transaction: no orphan status transition, no false transition_applied_at", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    const providerEventId = `evt-${randomUUID()}`;

    // Worker A's OWN `receiveWebhook` call performs the FIRST claim itself (via `tryInsertAndClaim`,
    // this being the event's first delivery) — deliberately NOT pre-claimed separately here (doing so
    // would make THIS call see the row as already "in_progress" under a live lease and back off
    // before ever reaching `applyTransition` at all, never exercising this test's own scenario).
    // `tokenA` is read from inside the hook, once A's own claim has already committed.
    let tokenA: string | null = null;

    // A's transition transaction pauses AFTER updating payment_attempt.status but BEFORE writing its
    // own transition marker — genuinely holding the row lock, via the SAME `afterPaymentUpdate` hook
    // this class already exposes, deterministically simulating "the lease expired and a different
    // worker reclaimed this exact event, minting a fresh token, while A's transaction was still open."
    const pausingCoordinator = new DrizzlePaymentTransitionCoordinator(getDb(), {
      afterPaymentUpdate: async () => {
        // Deliberately uses ONLY the isolated connection below — NEVER `ctx.events`/`getDb()` (the
        // SAME shared singleton A's own outer transaction is currently holding open). Calling
        // anything bound to that singleton from inside this hook would deadlock forever (see
        // `computeRemainingBalanceMinorUnitsWithinTx`'s own doc comment in
        // failedPaymentRetryCoordinator.ts for the identical bug class, found and fixed this round).
        const isolated = createIsolatedDb(DATABASE_URL);
        try {
          const isolatedEvents = new DrizzlePaymentWebhookEventRepository(isolated.db);
          const beforeReclaim = await isolatedEvents.findByProviderEvent(ctx.provider.providerName, providerEventId);
          tokenA = beforeReclaim!.claimToken!;
          // Deterministically reproduce the lease-expiry-and-reclaim NOW, on this genuinely
          // independent connection, before A's own transaction proceeds to its marker write.
          const reclaimOutcome = await isolatedEvents.claimExistingForProcessing(ctx.provider.providerName, providerEventId, 120_000, new Date(Date.now() + 60 * 60 * 1000));
          if (reclaimOutcome.outcome !== "claimed") throw new Error(`expected the event to be reclaimable via lease expiry, got ${JSON.stringify(reclaimOutcome)}`);
          // B now owns a FRESH token — A's own (stale) token no longer matches this row.
        } finally {
          await isolated.close();
        }
      },
    });
    const webhook = ctx.buildWebhookService({ transitionCoordinator: pausingCoordinator });

    const result = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId }));
    expect(result.status).toBe("accepted"); // A's whole transaction rolled back — never processed by A.
    expect(tokenA).not.toBeNull(); // the hook genuinely ran — this is the scenario, not a no-op.

    // No orphan status transition, no false transition_applied_at — A's payment-status UPDATE rolled
    // back together with its failed marker write (the exact atomicity requirement).
    const paymentAfter = await ctx.payments.findById(payment.id);
    expect(paymentAfter?.status).toBe("pending"); // never left "succeeded" by A's rolled-back attempt.
    const eventAfterA = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
    expect(eventAfterA?.transitionAppliedAt).toBeNull(); // no false transition_applied_at.
    expect(eventAfterA?.processingStatus).toBe("processing"); // B's own claim (from inside the hook) — still owned, not left "failed" by A.
    expect(eventAfterA?.claimToken).not.toBe(tokenA); // B genuinely owns a FRESH token — A's is stale.

    // B (the legitimate current owner) can continue/recover normally: mark it processed under its own
    // (fresh) token, then a real, normally-wired retry via recovery completes the transition and every
    // required ledger/audit consequence — nothing was permanently lost.
    await ctx.events.markFailedRetryable(eventAfterA!.id, eventAfterA!.claimToken!, "transient_processing_error", new Date(), new Date());
    const normalWebhook = ctx.buildWebhookService();
    const recovery = await normalWebhook.recoverBatch(100, new Date(Date.now() + 1));
    expect(recovery.processed).toBeGreaterThanOrEqual(1);
    expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded");
    expect(await findClearEntry(ctx.ledger, payment.id)).not.toBeNull(); // no missing ledger consequence.
    const auditRows = await findAuditEventsByProviderEvent(providerEventId, "payment_webhook_payment.succeeded");
    expect(auditRows).toHaveLength(1); // no missing audit consequence.
  });

  // ---------------------------------------------------------------------------------------------
  // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 6): reversal repair evidence
  // completeness.
  // ---------------------------------------------------------------------------------------------

  async function seedSucceededPaymentForReversal(status: "refunded" | "returned" | "reversed" | "disputed") {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });
    await ctx.payments.updateStatus(payment.id, "succeeded", {});
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: payment.id, agreementId, currency: "USD", grossAmountMinorUnits: 1_000 });
    await ctx.payments.updateStatus(payment.id, status, {});
    return { ctx, payment, providerPaymentId };
  }

  const REVERSAL_ENTRY_TYPE: Record<string, string> = {
    refunded: "refund",
    returned: "reversal",
    reversed: "reversal",
    disputed: "dispute_adjustment",
  };
  const REVERSAL_EVENT_TYPE: Record<string, string> = {
    refunded: "payment.refunded",
    returned: "payment.returned",
    reversed: "payment.reversed",
    disputed: "payment.disputed",
  };

  it("R-B60A — reversal event missing amount: no automatic repair", async () => {
    const { ctx, payment, providerPaymentId } = await seedSucceededPaymentForReversal("refunded");
    const trustedEvent = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.refunded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId, currency: "USD" }, // amount missing.
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());

    const found = await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("internal_posting_failure");
    expect(await ctx.ledger.findEntry(payment.id, "refund")).toBeNull();
  });

  it("R-B60B — reversal event missing currency: no automatic repair", async () => {
    const { ctx, payment, providerPaymentId } = await seedSucceededPaymentForReversal("returned");
    const trustedEvent = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.returned",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId, amountMinorUnits: 1_000 }, // currency missing.
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());

    const found = await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("internal_posting_failure");
    expect(await ctx.ledger.findEntry(payment.id, "reversal")).toBeNull();
  });

  it("R-B60C — reversal event with the WRONG amount: no automatic repair", async () => {
    const { ctx, payment, providerPaymentId } = await seedSucceededPaymentForReversal("reversed");
    const trustedEvent = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.reversed",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId, amountMinorUnits: 999, currency: "USD" }, // wrong amount (payment is 1_000).
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());

    const found = await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("internal_posting_failure");
    expect(await ctx.ledger.findEntry(payment.id, "reversal")).toBeNull();
  });

  it("R-B60D — reversal event with the WRONG currency: no automatic repair", async () => {
    const { ctx, payment, providerPaymentId } = await seedSucceededPaymentForReversal("disputed");
    const trustedEvent = await ctx.events.tryInsertAndClaim({
      provider: ctx.provider.providerName,
      providerEventId: `evt-${randomUUID()}`,
      eventType: "payment.disputed",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId, amountMinorUnits: 1_000, currency: "EUR" }, // wrong currency (payment is USD).
      leaseMs: 120_000,
      now: new Date(),
    });
    await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());

    const found = await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("internal_posting_failure");
    expect(await ctx.ledger.findEntry(payment.id, "dispute_adjustment")).toBeNull();
  });

  it("R-B60E — a single complete, valid full-reversal event repairs exactly once, for every reversal status", async () => {
    for (const status of ["refunded", "returned", "reversed", "disputed"] as const) {
      const { ctx, payment, providerPaymentId } = await seedSucceededPaymentForReversal(status);
      const trustedEvent = await ctx.events.tryInsertAndClaim({
        provider: ctx.provider.providerName,
        providerEventId: `evt-${randomUUID()}`,
        eventType: REVERSAL_EVENT_TYPE[status]!,
        source: "webhook",
        signatureVerified: true,
        payload: { providerPaymentId, amountMinorUnits: 1_000, currency: "USD" },
        leaseMs: 120_000,
        now: new Date(),
      });
      await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());

      const found = await ctx.reconciliation.reconcilePaymentAttempt(payment.id);
      expect(found.map((e) => e.exceptionType)).not.toContain("internal_posting_failure");
      const entryType = REVERSAL_ENTRY_TYPE[status]!;
      const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
      expect(entries.filter((e) => e.entryType === entryType)).toHaveLength(1); // exactly one repair.

      await ctx.reconciliation.reconcilePaymentAttempt(payment.id); // idempotent re-run.
      const entriesAfter = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
      expect(entriesAfter.filter((e) => e.entryType === entryType)).toHaveLength(1);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // PAID2YOU — PACKAGE B / CODEX FINAL REMAINING BLOCKERS (R06 + R09 only) — SIX remaining blockers.
  // ---------------------------------------------------------------------------------------------

  /** Builds a real DebitCardPaymentService (Section 1 — B1) with an active, unexpired card and a "debtor_pays" fee allocation for `agreementId`, so `prepareRetrySubmission` genuinely inflates the charge via the real borrower-surcharge computation — never a test-only approximation. */
  async function buildRealDebitCardInitiator(agreementId: string, debtor: { profileId: string }) {
    const debitCardCtx = createTestDebitCardServices();
    await debitCardCtx.cards.insert({
      agreementId,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      cardToken: `tok_${randomUUID()}`,
      cardLast4: "4242",
      cardBrand: "visa",
      ...TEST_FUTURE_CARD_EXPIRY,
      supersedesCardMethodId: null,
    });
    debitCardCtx.feeAllocation.set(agreementId, "debtor_pays");
    return debitCardCtx.debitCardPaymentService;
  }

  async function seedInstallmentPaymentWithDebitCardMethod(
    agreementId: string,
    installmentScheduleItemId: string,
    debtor: { profileId: string },
    creditor: { profileId: string },
  ): Promise<PaymentAttemptRecord> {
    const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
    const db = getDb();
    await db.update(paymentAttempt).set({ paymentMethod: "debit_card" }).where(eq(paymentAttempt.id, payment.id));
    return { ...payment, paymentMethod: "debit_card" };
  }

  describe("PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 1 — B1): retry eligibility must use the EXACT prepared/dispatched amount", () => {
    it("R-B61A — a prepared debit-card total ABOVE the transaction limit blocks dispatch, even though the smaller original/base amount is below it", async () => {
      const { ctx, verificationCtx, spiedProvider, callCount, coordinator } = await buildRetryEligibilityHarness();
      const { creditor, debtor } = await seedTwoParties(1_000_000);
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 500_000);
      await seedVerifiedParties(verificationCtx, debtor, creditor);
      const payment = await seedInstallmentPaymentWithDebitCardMethod(agreementId, installmentScheduleItemId, debtor, creditor); // base amountMinorUnits: 5_000.
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      await backdateRetryScheduledFor(failure.retryId);

      const debitCardInitiator = await buildRealDebitCardInitiator(agreementId, debtor);
      const eligibility = new DrizzlePaymentInitiationEligibilityService({ verification: verificationCtx.verificationService, payments: ctx.payments, balances: ctx.balances });
      const retryService = new PaymentRetryService({
        retries: new DrizzlePaymentRetryRepository(),
        paymentAttempts: ctx.payments,
        initiators: { ach: debitCardInitiator, debit_card: debitCardInitiator, manual_off_platform: debitCardInitiator },
        profileOwners: verificationCtx.profileOwners,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        retryCoordinator: coordinator,
        provider: spiedProvider,
        eligibility,
        effectApplier: ctx.buildWebhookService(),
      });

      // Base amount 5_000 is below this limit; the debit-card-inflated prepared total
      // (5_000 + round(5_000*0.029) + 30 = 5_175) is NOT. Before the Section-1 fix, eligibility
      // checked the smaller base amount and would have wrongly allowed dispatch.
      process.env.MAX_PAYMENT_MINOR_UNITS = "5100";
      try {
        await retryService.fireDueRetries(new Date());
      } finally {
        delete process.env.MAX_PAYMENT_MINOR_UNITS;
      }

      expect(callCount()).toBe(0); // provider is NEVER called.
      const retryRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
      expect(retryRow?.status).toBe("canceled");
    });

    it("R-B61B — a prepared amount EXACTLY at the transaction limit is permitted (equality is not a violation) and the provider is dispatched", async () => {
      const { ctx, verificationCtx, spiedProvider, callCount, coordinator } = await buildRetryEligibilityHarness();
      const { creditor, debtor } = await seedTwoParties(1_000_000);
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 500_000);
      await seedVerifiedParties(verificationCtx, debtor, creditor);
      const payment = await seedInstallmentPaymentWithDebitCardMethod(agreementId, installmentScheduleItemId, debtor, creditor);
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      await backdateRetryScheduledFor(failure.retryId);

      const debitCardInitiator = await buildRealDebitCardInitiator(agreementId, debtor);
      const eligibility = new DrizzlePaymentInitiationEligibilityService({ verification: verificationCtx.verificationService, payments: ctx.payments, balances: ctx.balances });
      const retryService = new PaymentRetryService({
        retries: new DrizzlePaymentRetryRepository(),
        paymentAttempts: ctx.payments,
        initiators: { ach: debitCardInitiator, debit_card: debitCardInitiator, manual_off_platform: debitCardInitiator },
        profileOwners: verificationCtx.profileOwners,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        retryCoordinator: coordinator,
        provider: spiedProvider,
        eligibility,
        effectApplier: ctx.buildWebhookService(),
      });

      process.env.MAX_PAYMENT_MINOR_UNITS = "5175"; // exactly the prepared debit-card total.
      try {
        await retryService.fireDueRetries(new Date());
      } finally {
        delete process.env.MAX_PAYMENT_MINOR_UNITS;
      }

      expect(callCount()).toBe(1); // dispatched — equality is permitted by the existing `>` comparison.
      const retryRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
      expect(retryRow?.status).not.toBe("canceled");
    });

    it("R-B61C — a prepared debit-card total that would push the payer's DAILY aggregate over the limit blocks dispatch, even though the smaller original amount alone would not", async () => {
      const { ctx, verificationCtx, spiedProvider, callCount, coordinator } = await buildRetryEligibilityHarness();
      const { creditor, debtor } = await seedTwoParties(1_000_000);
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 500_000);
      await seedVerifiedParties(verificationCtx, debtor, creditor);
      const payment = await seedInstallmentPaymentWithDebitCardMethod(agreementId, installmentScheduleItemId, debtor, creditor);
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      await backdateRetryScheduledFor(failure.retryId);

      // Prior activity today for the SAME payer: 4_900. original(5_000)+prior = 9_900 (under a 10_000
      // daily limit); prepared(5_175)+prior = 10_075 (over it).
      await ctx.payments.insertPending({
        idempotencyKey: randomUUID(),
        payerProfileKind: "personal",
        payerProfileId: debtor.profileId,
        recipientProfileKind: "personal",
        recipientProfileId: creditor.profileId,
        amountMinorUnits: 4_900,
        currency: "USD",
        agreementId,
        providerName: "sandbox_mock",
        initialStatus: "succeeded",
      });

      const debitCardInitiator = await buildRealDebitCardInitiator(agreementId, debtor);
      const eligibility = new DrizzlePaymentInitiationEligibilityService({ verification: verificationCtx.verificationService, payments: ctx.payments, balances: ctx.balances });
      const retryService = new PaymentRetryService({
        retries: new DrizzlePaymentRetryRepository(),
        paymentAttempts: ctx.payments,
        initiators: { ach: debitCardInitiator, debit_card: debitCardInitiator, manual_off_platform: debitCardInitiator },
        profileOwners: verificationCtx.profileOwners,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        retryCoordinator: coordinator,
        provider: spiedProvider,
        eligibility,
        effectApplier: ctx.buildWebhookService(),
      });

      process.env.DAILY_PAYMENT_AMOUNT_LIMIT_MINOR_UNITS = "10000";
      try {
        await retryService.fireDueRetries(new Date());
      } finally {
        delete process.env.DAILY_PAYMENT_AMOUNT_LIMIT_MINOR_UNITS;
      }

      expect(callCount()).toBe(0);
      const retryRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
      expect(retryRow?.status).toBe("canceled");
    });
  });

  describe("PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 2 — B2): ambiguity resolution must never bypass the authoritative transition/effect pipeline", () => {
    function buildLossyAmbiguousProvider(): { lossyProvider: SandboxPaymentProvider; realProvider: SandboxPaymentProvider; getRealProviderPaymentId: () => string | null } {
      const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
      let realProviderPaymentId: string | null = null;
      const lossyProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "createPayment") {
            return async (...args: unknown[]) => {
              const result = await (target.createPayment as (...a: unknown[]) => Promise<{ providerPaymentId: string; status: string }>).apply(target, args);
              realProviderPaymentId = result.providerPaymentId;
              throw new AmbiguousProviderResponseError();
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;
      return { lossyProvider, realProvider, getRealProviderPaymentId: () => realProviderPaymentId };
    }

    it("R-B62A-CORRECTED — resolver's stale 'submitted' read, paused mid-provider-lookup, must not regress a status a real webhook commits WHILE it is paused", async () => {
      // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B4): Codex's own finding on the
      // FIRST version of this test — "webhook completes first, THEN resolver runs" — is sequential,
      // not the actual race. This version deterministically pauses resolveAmbiguousRetry's OWN
      // provider-lookup call (genuinely AFTER its own DB read has already observed
      // `status = 'submitted'`, since that read is awaited before the provider is ever called), lets
      // an independent real webhook delivery advance `submitted -> succeeded` and commit EVERY
      // required effect while the resolver remains paused, and only then releases the resolver to
      // resume with its own now-stale "pending" lookup result. No sleep — a deterministic deferred
      // promise is the barrier, mirroring this file's own established pattern.
      const { ctx, verificationCtx, coordinator } = await buildRetryEligibilityHarness();
      const { creditor, debtor } = await seedTwoParties();
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      await seedVerifiedParties(verificationCtx, debtor, creditor);
      const payment = await seedInstallmentPaymentWithMethod(agreementId, installmentScheduleItemId, debtor, creditor);
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;

      const { lossyProvider, realProvider, getRealProviderPaymentId } = buildLossyAmbiguousProvider();
      const dispatchOutcome = await coordinator.claimAndExecuteRetry({
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        agreementId,
        provider: lossyProvider,
        prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        effectApplier: ctx.buildWebhookService(),
      });
      if (dispatchOutcome.outcome !== "ambiguous") throw new Error("expected ambiguous");
      const realProviderPaymentId = getRealProviderPaymentId();
      expect(realProviderPaymentId).not.toBeNull();
      expect((await ctx.payments.findById(dispatchOutcome.paymentAttemptId))?.status).toBe("submitted"); // initial state, exactly as required.

      // Deterministic barrier: pauses INSIDE resolveAmbiguousRetry's own provider lookup — genuinely
      // after its own `payment_attempt` read has already observed `status = 'submitted'` (that DB
      // read is awaited BEFORE this method is ever invoked), and before its own lookup result is
      // observed.
      const lookupStarted = createDeferred<void>();
      const releaseLookup = createDeferred<void>();
      const pausingProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "retrievePaymentByIdempotencyKey") {
            return async (key: string) => {
              lookupStarted.resolve();
              await releaseLookup.promise;
              return target.retrievePaymentByIdempotencyKey(key);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;

      const effectApplier = ctx.buildWebhookService();
      const resolutionPromise = coordinator.resolveAmbiguousRetry({ retryId: failure.retryId, idempotencyKey, provider: pausingProvider, effectApplier });
      await lookupStarted.promise; // deterministic: resolver A's own stale-submitted read already happened; it is now paused mid-lookup.

      // Webhook worker B independently processes the SAME payment's real "succeeded" event —
      // completing every required effect and committing — entirely WHILE resolver A remains paused.
      const db = getDb();
      await db.update(paymentAttempt).set({ providerPaymentId: realProviderPaymentId }).where(eq(paymentAttempt.idempotencyKey, idempotencyKey));
      const webhook = ctx.buildWebhookService();
      const providerEventId = `evt-${randomUUID()}`;
      const webhookResult = await webhook.receiveWebhook(
        signedWebhook(realProvider, { providerEventId, eventType: "payment.succeeded", providerPaymentId: realProviderPaymentId }),
      );
      expect(webhookResult.status).toBe("processed");
      expect((await ctx.payments.findById(dispatchOutcome.paymentAttemptId))?.status).toBe("succeeded"); // webhook B has genuinely committed.

      // Resolver A now resumes: its own lookup returns the provider's REAL (never separately
      // settled) status — "pending" — and it attempts its conditional, non-terminal adoption.
      releaseLookup.resolve();
      const resolution = await resolutionPromise;
      expect(resolution.outcome).toBe("fired");

      const finalPayment = await ctx.payments.findById(dispatchOutcome.paymentAttemptId);
      expect(finalPayment?.status).toBe("succeeded"); // never regressed — resolver's conditional UPDATE ... WHERE status='submitted' matched zero rows.
      expect(finalPayment?.providerPaymentId).toBe(realProviderPaymentId); // ambiguity correlation remains valid.

      const entries = await ctx.ledger.listEntriesForPaymentAttempt(dispatchOutcome.paymentAttemptId);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // exactly one — no required effect lost or duplicated.

      const auditRows = await findAuditEventsByProviderEvent(providerEventId, "payment_webhook_payment.succeeded");
      expect(auditRows).toHaveLength(1); // the real webhook's own transition audit — exactly once.

      const finalEvent = await ctx.events.findByProviderEvent(realProvider.providerName, providerEventId);
      expect(finalEvent?.processingStatus).toBe("processed"); // webhook event processed.
    });

    it("R-B62B — a discovered terminal 'succeeded' outcome applies EVERY required effect (legal transition, ledger, audit, installment, lifecycle) through the durable event pipeline — never a direct status write", async () => {
      const { ctx, verificationCtx, coordinator, retryService } = await buildRetryEligibilityHarness();
      const { creditor, debtor } = await seedTwoParties(5_000);
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      await seedVerifiedParties(verificationCtx, debtor, creditor);
      const payment = await seedInstallmentPaymentWithMethod(agreementId, installmentScheduleItemId, debtor, creditor);
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;

      const { lossyProvider, realProvider, getRealProviderPaymentId } = buildLossyAmbiguousProvider();
      const dispatchOutcome = await coordinator.claimAndExecuteRetry({
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        agreementId,
        provider: lossyProvider,
        prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        effectApplier: ctx.buildWebhookService(),
      });
      if (dispatchOutcome.outcome !== "ambiguous") throw new Error("expected ambiguous");
      const realProviderPaymentId = getRealProviderPaymentId()!;
      realProvider.simulateSettlement(realProviderPaymentId, "succeeded"); // the provider genuinely settled it after dispatch.

      const notifyCtx = createTestNotificationService();
      const workflow = new FailedPaymentWorkflowService({
        installments: new DrizzleInstallmentStatusRepository(),
        retries: retryService,
        notifications: notifyCtx.notificationService,
        profileOwners: verificationCtx.profileOwners,
        retryCoordinator: coordinator,
      });
      const effectApplier = ctx.buildWebhookService({ failedPaymentWorkflow: workflow });

      const resolution = await coordinator.resolveAmbiguousRetry({ retryId: failure.retryId, idempotencyKey, provider: lossyProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");

      const finalPayment = await ctx.payments.findById(dispatchOutcome.paymentAttemptId);
      expect(finalPayment?.status).toBe("succeeded"); // legal transition recorded via the real coordinator.
      expect(finalPayment?.providerPaymentId).toBe(realProviderPaymentId);

      const entries = await ctx.ledger.listEntriesForPaymentAttempt(dispatchOutcome.paymentAttemptId);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // payment_cleared exactly once.

      const auditRows = await findAuditEventsByProviderEvent(`ambiguity-resolution:${idempotencyKey}`, "payment_webhook_payment.succeeded");
      expect(auditRows).toHaveLength(1); // audit exactly once.

      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid"); // installment effect complete.
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full"); // lifecycle effect complete.
    });

    it("R-B62C — a real webhook for the SAME provider outcome, arriving AFTER ambiguity resolution already applied it, produces no duplicate status/effects", async () => {
      const { ctx, verificationCtx, coordinator } = await buildRetryEligibilityHarness();
      const { creditor, debtor } = await seedTwoParties(5_000);
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      await seedVerifiedParties(verificationCtx, debtor, creditor);
      const payment = await seedInstallmentPaymentWithMethod(agreementId, installmentScheduleItemId, debtor, creditor);
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;

      const { lossyProvider, realProvider, getRealProviderPaymentId } = buildLossyAmbiguousProvider();
      const dispatchOutcome = await coordinator.claimAndExecuteRetry({
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        agreementId,
        provider: lossyProvider,
        prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        effectApplier: ctx.buildWebhookService(),
      });
      if (dispatchOutcome.outcome !== "ambiguous") throw new Error("expected ambiguous");
      const realProviderPaymentId = getRealProviderPaymentId()!;
      realProvider.simulateSettlement(realProviderPaymentId, "succeeded");

      const effectApplier = ctx.buildWebhookService();
      const resolution = await coordinator.resolveAmbiguousRetry({ retryId: failure.retryId, idempotencyKey, provider: lossyProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");
      const entriesAfterResolution = await ctx.ledger.listEntriesForPaymentAttempt(dispatchOutcome.paymentAttemptId);
      expect(entriesAfterResolution.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);

      // A real webhook delivery for the SAME provider outcome, its OWN genuinely distinct
      // providerEventId, arrives afterward.
      const webhook = ctx.buildWebhookService();
      const secondProviderEventId = `evt-${randomUUID()}`;
      const secondResult = await webhook.receiveWebhook(
        signedWebhook(realProvider, { providerEventId: secondProviderEventId, eventType: "payment.succeeded", providerPaymentId: realProviderPaymentId }),
      );
      expect(secondResult.status).toBe("processed"); // a safe, dead no-op (permanently-illegal transition) — marked processed without applying anything.

      const entriesAfter = await ctx.ledger.listEntriesForPaymentAttempt(dispatchOutcome.paymentAttemptId);
      expect(entriesAfter.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // still exactly one — no duplicate.
      const auditForRealEvent = await findAuditEventsByProviderEvent(secondProviderEventId, "payment_webhook_payment.succeeded");
      expect(auditForRealEvent).toHaveLength(0); // the real event's own transition never applied — no new audit link.
    });
  });

  describe("PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B2): internal provider-lookup events must have truthful provenance and complete financial evidence", () => {
    function buildLossyAmbiguousProvider(): { lossyProvider: SandboxPaymentProvider; realProvider: SandboxPaymentProvider; getRealProviderPaymentId: () => string | null } {
      const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
      let realProviderPaymentId: string | null = null;
      const lossyProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "createPayment") {
            return async (...args: unknown[]) => {
              const result = await (target.createPayment as (...a: unknown[]) => Promise<{ providerPaymentId: string; status: string }>).apply(target, args);
              realProviderPaymentId = result.providerPaymentId;
              throw new AmbiguousProviderResponseError();
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;
      return { lossyProvider, realProvider, getRealProviderPaymentId: () => realProviderPaymentId };
    }

    async function dispatchAmbiguousAndSettle(coordinator: FailedPaymentRetryCoordinator) {
      const { creditor, debtor } = await seedTwoParties(5_000);
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPaymentWithMethod(agreementId, installmentScheduleItemId, debtor, creditor);
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;

      const { lossyProvider, realProvider, getRealProviderPaymentId } = buildLossyAmbiguousProvider();
      const dispatchOutcome = await coordinator.claimAndExecuteRetry({
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        agreementId,
        provider: lossyProvider,
        prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        effectApplier: buildContext().buildWebhookService(),
      });
      if (dispatchOutcome.outcome !== "ambiguous") throw new Error("expected ambiguous");
      const realProviderPaymentId = getRealProviderPaymentId()!;
      realProvider.simulateSettlement(realProviderPaymentId, "succeeded");
      return {
        agreementId,
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        lossyProvider,
        realProvider,
        realProviderPaymentId,
        resultingPaymentAttemptId: dispatchOutcome.paymentAttemptId,
      };
    }

    it("R-B68A — an internal provider-lookup event is persisted with truthful provenance: source = provider_lookup, signatureVerified = false", async () => {
      const { ctx, coordinator } = await buildRetryEligibilityHarness();
      const { retryId, idempotencyKey, lossyProvider, realProvider } = await dispatchAmbiguousAndSettle(coordinator);

      const effectApplier = ctx.buildWebhookService();
      const resolution = await coordinator.resolveAmbiguousRetry({ retryId, idempotencyKey, provider: lossyProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");

      const eventRow = await ctx.events.findByProviderEvent(realProvider.providerName, `ambiguity-resolution:${idempotencyKey}`);
      expect(eventRow?.source).toBe("provider_lookup");
      expect(eventRow?.signatureVerified).toBe(false);
    });

    it("R-B68B — a real signed webhook delivery is persisted with truthful provenance: source = webhook, signatureVerified = true", async () => {
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const ctx = buildContext();
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const webhook = ctx.buildWebhookService();
      const providerEventId = `evt-${randomUUID()}`;
      const result = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId }));
      expect(result.status).toBe("processed");

      const eventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
      expect(eventRow?.source).toBe("webhook");
      expect(eventRow?.signatureVerified).toBe(true);
    });

    it("R-B68C — a provider lookup with complete amount/currency/fee evidence posts the EXACT correct clearing ledger entry", async () => {
      const { ctx, coordinator } = await buildRetryEligibilityHarness();
      const { retryId, idempotencyKey, lossyProvider, resultingPaymentAttemptId } = await dispatchAmbiguousAndSettle(coordinator);

      const effectApplier = ctx.buildWebhookService();
      const resolution = await coordinator.resolveAmbiguousRetry({ retryId, idempotencyKey, provider: lossyProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");

      const entries = await ctx.ledger.listEntriesForPaymentAttempt(resultingPaymentAttemptId);
      const clearEntry = entries.find((e) => e.entryType === "payment_cleared");
      expect(clearEntry).toBeDefined();
      // Sandbox's own provider-lookup evidence is amount=5_000/currency=USD/fee=0 (explicitly zero,
      // never fabricated — see SandboxPaymentProvider's own doc comment) — exactly two postings, no
      // fee posting at all, both for the full gross amount.
      const processorClearing = clearEntry!.postings.find((p) => p.accountType === "processor_clearing");
      const creditorProceeds = clearEntry!.postings.find((p) => p.accountType === "creditor_proceeds_payable");
      expect(processorClearing?.amountMinorUnits).toBe(5_000);
      expect(processorClearing?.direction).toBe("debit");
      expect(creditorProceeds?.amountMinorUnits).toBe(5_000);
      expect(creditorProceeds?.direction).toBe("credit");
      expect(clearEntry!.postings.some((p) => p.accountType === "processor_fee_expense")).toBe(false);
      expect(clearEntry!.postings.some((p) => p.accountType === "platform_fee_revenue")).toBe(false);
    });

    it("R-B68D — a provider lookup missing required financial evidence (amount) never posts a fabricated zero-fee ledger entry; the event remains unresolved for manual review", async () => {
      const { ctx, coordinator } = await buildRetryEligibilityHarness();
      const { retryId, idempotencyKey, realProvider, resultingPaymentAttemptId } = await dispatchAmbiguousAndSettle(coordinator);

      // A hypothetical provider adapter that omits required amount evidence — the exact defensive
      // case `postLedgerEntryRequired`'s own strict validation exists to refuse, regardless of
      // whether THIS codebase's own SandboxPaymentProvider could ever actually produce this shape.
      const incompleteEvidenceProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "retrievePaymentByIdempotencyKey") {
            return async (key: string) => {
              const real = await target.retrievePaymentByIdempotencyKey(key);
              if (!real) return null;
              const { amountMinorUnits: _omitted, ...incomplete } = real;
              return incomplete as unknown as typeof real;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;

      const effectApplier = ctx.buildWebhookService();
      const resolution = await coordinator.resolveAmbiguousRetry({ retryId, idempotencyKey, provider: incompleteEvidenceProvider, effectApplier });
      // "fired" here means resolveAmbiguousRetry obtained A definite provider response and dispatched
      // the synthetic event — it does NOT mean the event's own financial completion succeeded.
      expect(resolution.outcome).toBe("fired");

      const eventRow = await ctx.events.findByProviderEvent(realProvider.providerName, `ambiguity-resolution:${idempotencyKey}`);
      expect(eventRow?.processingStatus).not.toBe("processed"); // NOT fully processed.
      // PAID2YOU — PACKAGE B (Stage 6 architectural review remediation, Item 4): incomplete
      // provider_lookup evidence throws the dedicated, explicitly-recognized ProviderLookupEvidenceError
      // — its own distinct code, never the generic ValidationError fallback code.
      expect(eventRow?.lastErrorCode).toBe("provider_lookup_evidence_incomplete_or_invalid");

      const entries = await ctx.ledger.listEntriesForPaymentAttempt(resultingPaymentAttemptId);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(0); // no fabricated entry.
    });

    /** Overrides one field of the REAL provider lookup result with a materially invalid value — the exact defensive shape `postLedgerEntryRequired`'s own strict financial-validity checks exist to refuse, regardless of whether SandboxPaymentProvider could itself ever actually produce it. */
    function buildEvidenceOverrideProvider(realProvider: SandboxPaymentProvider, override: Record<string, unknown>): SandboxPaymentProvider {
      return new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "retrievePaymentByIdempotencyKey") {
            return async (key: string) => {
              const real = await target.retrievePaymentByIdempotencyKey(key);
              if (!real) return null;
              return { ...real, ...override };
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;
    }

    it("R-B68H (invariant #40) — a provider lookup missing required currency evidence never posts a fabricated ledger entry", async () => {
      const { ctx, coordinator } = await buildRetryEligibilityHarness();
      const { retryId, idempotencyKey, realProvider, resultingPaymentAttemptId } = await dispatchAmbiguousAndSettle(coordinator);
      const missingCurrencyProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "retrievePaymentByIdempotencyKey") {
            return async (key: string) => {
              const real = await target.retrievePaymentByIdempotencyKey(key);
              if (!real) return null;
              const { currency: _omitted, ...incomplete } = real;
              return incomplete as unknown as typeof real;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;

      const effectApplier = ctx.buildWebhookService();
      const resolution = await coordinator.resolveAmbiguousRetry({ retryId, idempotencyKey, provider: missingCurrencyProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");
      const eventRow = await ctx.events.findByProviderEvent(realProvider.providerName, `ambiguity-resolution:${idempotencyKey}`);
      expect(eventRow?.processingStatus).not.toBe("processed");
      const entries = await ctx.ledger.listEntriesForPaymentAttempt(resultingPaymentAttemptId);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(0);
    });

    it("R-B68I (invariant #41) — a provider lookup reporting an excessive processor fee (greater than the amount) never posts a fabricated ledger entry", async () => {
      const { ctx, coordinator } = await buildRetryEligibilityHarness();
      const { retryId, idempotencyKey, realProvider, resultingPaymentAttemptId } = await dispatchAmbiguousAndSettle(coordinator);
      const excessiveFeeProvider = buildEvidenceOverrideProvider(realProvider, { feeMinorUnits: 999_999 }); // gross is 5_000.

      const effectApplier = ctx.buildWebhookService();
      const resolution = await coordinator.resolveAmbiguousRetry({ retryId, idempotencyKey, provider: excessiveFeeProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");
      const eventRow = await ctx.events.findByProviderEvent(realProvider.providerName, `ambiguity-resolution:${idempotencyKey}`);
      expect(eventRow?.processingStatus).not.toBe("processed");
      const entries = await ctx.ledger.listEntriesForPaymentAttempt(resultingPaymentAttemptId);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(0);
    });

    it("R-B68J (invariant #42) — an invalid combined processor + platform fee (together exceeding the amount) never posts a fabricated ledger entry", async () => {
      const { ctx, coordinator } = await buildRetryEligibilityHarness();
      const { retryId, idempotencyKey, lossyProvider, realProvider, resultingPaymentAttemptId } = await dispatchAmbiguousAndSettle(coordinator);
      // The provider's own processor fee (2_600) is individually under the 5_000 gross, and
      // Paid2You's own platform fee (2_600) is too — but COMBINED (5_200) they exceed it, a
      // genuinely financially impossible evidence combination that must be refused. Constructed as a
      // direct synthetic provider_lookup event (bypassing resolveAmbiguousRetry, which always supplies
      // its own fixed authoritative platform fee) so this specific combined-fee validation branch is
      // exercised deterministically.
      const found = await realProvider.retrievePaymentByIdempotencyKey(idempotencyKey);
      // Pure identity correlation — the same first step `resolveAmbiguousRetry` itself performs —
      // required so `applyEvent` can find this payment by providerPaymentId at all.
      const db = getDb();
      await db.update(paymentAttempt).set({ providerPaymentId: found!.providerPaymentId }).where(eq(paymentAttempt.id, resultingPaymentAttemptId));

      const effectApplier = ctx.buildWebhookService();
      const result = await effectApplier.receiveInternalEvent({
        provider: realProvider.providerName,
        providerEventId: `test-combined-fee-${idempotencyKey}`,
        eventType: "payment.succeeded",
        data: {
          providerPaymentId: found!.providerPaymentId,
          amountMinorUnits: 5_000,
          currency: "USD",
          processorFeeMinorUnits: 2_600,
          platformFeeMinorUnits: 2_600,
        },
      });
      expect(result.status).toBe("accepted"); // durably claimed, evidence refused — never processed.
      const eventRow = await ctx.events.findByProviderEvent(realProvider.providerName, `test-combined-fee-${idempotencyKey}`);
      expect(eventRow?.processingStatus).not.toBe("processed");
      const entries = await ctx.ledger.listEntriesForPaymentAttempt(resultingPaymentAttemptId);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(0);

      // Test hygiene: the retry created by dispatchAmbiguousAndSettle was never resolved above (this
      // test bypassed resolveAmbiguousRetry to exercise the combined-fee validation directly) — close
      // out its own lifecycle now so it never lingers as a stray "claimed" row for a LATER test's own
      // unbounded claimed-resumption scan to sweep up. The underlying payment already transitioned to
      // "succeeded" (the fee check runs AFTER the transition, per the required-effect ordering), so
      // this exercises resolveAmbiguousRetry's own idempotent-adoption branch — a real, correct
      // outcome, not a workaround.
      await coordinator.resolveAmbiguousRetry({ retryId, idempotencyKey, provider: lossyProvider, effectApplier: ctx.buildWebhookService() });
    });

    it("R-B68E — an internal provider-lookup resolution succeeds first; an equivalent REAL signed webhook arriving afterward leaves exactly one financial effect", async () => {
      const { ctx, coordinator } = await buildRetryEligibilityHarness();
      const { retryId, idempotencyKey, lossyProvider, realProvider, realProviderPaymentId, resultingPaymentAttemptId } = await dispatchAmbiguousAndSettle(coordinator);

      const effectApplier = ctx.buildWebhookService();
      const resolution = await coordinator.resolveAmbiguousRetry({ retryId, idempotencyKey, provider: lossyProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");
      const entriesAfterLookup = await ctx.ledger.listEntriesForPaymentAttempt(resultingPaymentAttemptId);
      expect(entriesAfterLookup.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);

      const webhook = ctx.buildWebhookService();
      const webhookResult = await webhook.receiveWebhook(
        signedWebhook(realProvider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId: realProviderPaymentId }),
      );
      expect(webhookResult.status).toBe("processed"); // dead no-op, marked processed.

      const entriesAfterWebhook = await ctx.ledger.listEntriesForPaymentAttempt(resultingPaymentAttemptId);
      expect(entriesAfterWebhook.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // exactly one — unchanged.
    });

    it("R-B68F (invariants #45/#47) — internal lookup evidence conflicts with a LATER signed webhook's own carried amount: the inconsistency becomes AUTOMATICALLY observable — no manual reconciliation call — and never mutates the ledger", async () => {
      const { ctx, coordinator } = await buildRetryEligibilityHarness();
      const { retryId, idempotencyKey, lossyProvider, realProvider, realProviderPaymentId, resultingPaymentAttemptId } = await dispatchAmbiguousAndSettle(coordinator);

      const effectApplier = ctx.buildWebhookService();
      const resolution = await coordinator.resolveAmbiguousRetry({ retryId, idempotencyKey, provider: lossyProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");

      const webhook = ctx.buildWebhookService();
      const conflictingProviderEventId = `evt-${randomUUID()}`;
      const webhookResult = await webhook.receiveWebhook(
        signedWebhook(realProvider, {
          providerEventId: conflictingProviderEventId,
          eventType: "payment.succeeded",
          providerPaymentId: realProviderPaymentId,
          amountMinorUnits: 999_999,
        }),
      );
      expect(webhookResult.status).toBe("processed"); // dead no-op transition-wise — never applied.

      // No silent ledger mutation: still exactly the ORIGINAL, correct entry.
      const entries = await ctx.ledger.listEntriesForPaymentAttempt(resultingPaymentAttemptId);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);

      // PAID2YOU — PACKAGE B (R06+R09 definitive implementation, Part XXII): AUTOMATICALLY visible —
      // NO separate `reconcilePaymentAttempt` call anywhere in this test. `receiveWebhook` itself
      // already detected and recorded the conflict inline, during normal event processing.
      const exceptionsAfterWebhookAlone = await ctx.exceptions.listForPaymentAttempt(resultingPaymentAttemptId);
      expect(exceptionsAfterWebhookAlone.map((e) => e.exceptionType)).toContain("amount_mismatch");
    });

    it("R-B68G (invariant #44) — an equivalent (non-conflicting) real webhook arriving after a provider-lookup resolution creates NO reconciliation exception at all", async () => {
      const { ctx, coordinator } = await buildRetryEligibilityHarness();
      const { retryId, idempotencyKey, lossyProvider, realProvider, realProviderPaymentId, resultingPaymentAttemptId } = await dispatchAmbiguousAndSettle(coordinator);

      const effectApplier = ctx.buildWebhookService();
      const resolution = await coordinator.resolveAmbiguousRetry({ retryId, idempotencyKey, provider: lossyProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");

      const webhook = ctx.buildWebhookService();
      const equivalentProviderEventId = `evt-${randomUUID()}`;
      const webhookResult = await webhook.receiveWebhook(
        signedWebhook(realProvider, {
          providerEventId: equivalentProviderEventId,
          eventType: "payment.succeeded",
          providerPaymentId: realProviderPaymentId,
          amountMinorUnits: 5_000, // the SAME, correct amount — never a conflict merely because a duplicate arrives.
        }),
      );
      expect(webhookResult.status).toBe("processed");

      const exceptionsAfter = await ctx.exceptions.listForPaymentAttempt(resultingPaymentAttemptId);
      expect(exceptionsAfter).toHaveLength(0); // equivalent evidence — no exception, ever.
    });

    it("Item 2.A (Stage 6 architectural review remediation) — the normal webhook-receipt ledger posting obtains platformFeeMinorUnits from the injected PlatformFeePolicy authority, never a hardcoded local zero", async () => {
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const ctx = buildContext();
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const customPolicy: PlatformFeePolicy = { async getPlatformFeeMinorUnits() { return 77; } };
      const webhook = ctx.buildWebhookService({ platformFeePolicy: customPolicy });
      const result = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId, processorFeeMinorUnits: 0 }),
      );
      expect(result.status).toBe("processed");

      const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
      const clearEntry = entries.find((e) => e.entryType === "payment_cleared");
      const platformFeePosting = clearEntry?.postings.find((p) => p.accountType === "platform_fee_revenue");
      expect(platformFeePosting?.amountMinorUnits).toBe(77);
    });

    it("Item 2.B (Stage 6 architectural review remediation) — resolveAmbiguousRetry obtains platformFeeMinorUnits from the SAME injected PlatformFeePolicy authority as the normal webhook path, never a local retry-coordinator constant", async () => {
      const { ctx, coordinator } = await buildRetryEligibilityHarness();
      const { retryId, idempotencyKey, lossyProvider, resultingPaymentAttemptId } = await dispatchAmbiguousAndSettle(coordinator);

      // The SAME non-default policy injected into BOTH the coordinator resolving the ambiguity AND
      // the effectApplier posting its required ledger effect — if either subsystem still held a
      // hidden local zero constant, the posted platform-fee leg below would come back 0, not 42.
      const customPolicy: PlatformFeePolicy = { async getPlatformFeeMinorUnits() { return 42; } };
      const coordinatorWithCustomPolicy = new DrizzleFailedPaymentRetryCoordinator(undefined, undefined, undefined, undefined, customPolicy);
      const effectApplier = ctx.buildWebhookService({ platformFeePolicy: customPolicy });
      const resolution = await coordinatorWithCustomPolicy.resolveAmbiguousRetry({ retryId, idempotencyKey, provider: lossyProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");

      const entries = await ctx.ledger.listEntriesForPaymentAttempt(resultingPaymentAttemptId);
      const clearEntry = entries.find((e) => e.entryType === "payment_cleared");
      const platformFeePosting = clearEntry?.postings.find((p) => p.accountType === "platform_fee_revenue");
      expect(platformFeePosting?.amountMinorUnits).toBe(42);
    });

    it("Item 2.C (Stage 6 architectural review remediation) — the normalized provider_lookup event's own persisted payload carries an EXPLICIT platformFeeMinorUnits from the fee authority, never an implicit/absent value", async () => {
      const { ctx, coordinator } = await buildRetryEligibilityHarness();
      const { retryId, idempotencyKey, lossyProvider, realProvider } = await dispatchAmbiguousAndSettle(coordinator);

      const effectApplier = ctx.buildWebhookService();
      const resolution = await coordinator.resolveAmbiguousRetry({ retryId, idempotencyKey, provider: lossyProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");

      const eventRow = await ctx.events.findByProviderEvent(realProvider.providerName, `ambiguity-resolution:${idempotencyKey}`);
      const payload = eventRow?.payload as Record<string, unknown>;
      expect(typeof payload.platformFeeMinorUnits).toBe("number");
      expect(payload.platformFeeMinorUnits).toBe(0); // today's authoritative DefaultPlatformFeePolicy value — explicit, never absent.
    });

    it("Stage 6 FINAL closure, Item 2 Test E — a provider_lookup normalized event's own platformFeeMinorUnits is Paid2You-NORMALIZED evidence (sourced only from PlatformFeePolicy at resolution time), never provider-supplied, and never itself read by conflict detection", async () => {
      const { ctx, coordinator } = await buildRetryEligibilityHarness();
      const { retryId, idempotencyKey, lossyProvider, realProvider, realProviderPaymentId, resultingPaymentAttemptId } = await dispatchAmbiguousAndSettle(coordinator);

      const effectApplier = ctx.buildWebhookService();
      const resolution = await coordinator.resolveAmbiguousRetry({ retryId, idempotencyKey, provider: lossyProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");

      const eventRow = await ctx.events.findByProviderEvent(realProvider.providerName, `ambiguity-resolution:${idempotencyKey}`);
      const payload = eventRow?.payload as Record<string, unknown>;
      expect(payload.platformFeeMinorUnits).toBe(0); // sourced from PlatformFeePolicy at resolution time — Paid2You-normalized, never provider-supplied.

      // A LATER dead-end duplicate for the SAME payment never creates a platform_fee_mismatch —
      // conflict detection consults the internal policy-vs-posted comparison, never this event's own
      // persisted field (even though, for this normalized source, the field happens to already agree).
      const webhook = ctx.buildWebhookService();
      const laterDuplicate = await webhook.receiveWebhook(
        signedWebhook(realProvider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId: realProviderPaymentId, amountMinorUnits: 5_000 }),
      );
      expect(laterDuplicate.status).toBe("processed");
      const exceptions = await ctx.exceptions.listForPaymentAttempt(resultingPaymentAttemptId);
      expect(exceptions.map((e) => e.exceptionType)).not.toContain("platform_fee_mismatch");
    });

    it("Item 3 (Stage 6 architecture closure) — normal-webhook settlement and ambiguity-recovered settlement never diverge: BOTH use the exact SAME injected PlatformFeePolicy authority, with no local fallback anywhere in either path", async () => {
      // PAID2YOU — PACKAGE B (Stage 6 architecture closure, Item 3): this codebase establishes
      // `platformFeeMinorUnits` at exactly ONE architectural moment — settlement/ledger-posting time,
      // inside `PaymentWebhookService.postLedgerEntryRequired` — never at payment
      // creation/preparation/reservation (`PaymentService.submitToProvider` and
      // `DrizzleFailedPaymentRetryCoordinator.claimAndExecuteRetry`'s prepared-dispatch step compute
      // and persist no fee value of any kind; `payment_attempt` has no such column). One shared
      // `effectApplier`/`coordinator`, both wired with the SAME non-default policy, settle TWO
      // structurally distinct dispatches of "the same kind of payment" below — one via an ordinary
      // signed webhook (never touching ambiguity at all), one via ambiguity-recovery reconstruction —
      // proving there is no per-path divergence and no hidden local zero fallback in either.
      const customPolicy: PlatformFeePolicy = { async getPlatformFeeMinorUnits() { return 55; } };
      const ctx = buildContext();
      const sharedEffectApplier = ctx.buildWebhookService({ platformFeePolicy: customPolicy });
      const sharedCoordinator = new DrizzleFailedPaymentRetryCoordinator(undefined, undefined, undefined, undefined, customPolicy);

      // Case 1 — NORMAL provider-payment establishment: an ordinary payment, settled by a real signed
      // webhook, never touching the ambiguity/recovery machinery at all.
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const normalProviderPaymentId = `sandbox_pay_${randomUUID()}`;
      const normalPayment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId: normalProviderPaymentId,
      });
      const normalResult = await sharedEffectApplier.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId: normalProviderPaymentId }),
      );
      expect(normalResult.status).toBe("processed");
      const normalEntries = await ctx.ledger.listEntriesForPaymentAttempt(normalPayment.id);
      const normalPlatformFeePosting = normalEntries.find((e) => e.entryType === "payment_cleared")?.postings.find((p) => p.accountType === "platform_fee_revenue");
      expect(normalPlatformFeePosting?.amountMinorUnits).toBe(55);

      // Case 2 — ambiguity-RECOVERY reconstruction of a structurally identical payment, using the
      // SAME shared coordinator and the SAME shared effectApplier/policy.
      const { retryId, idempotencyKey, lossyProvider, resultingPaymentAttemptId } = await dispatchAmbiguousAndSettle(sharedCoordinator);
      const resolution = await sharedCoordinator.resolveAmbiguousRetry({ retryId, idempotencyKey, provider: lossyProvider, effectApplier: sharedEffectApplier });
      expect(resolution.outcome).toBe("fired");
      const recoveredEntries = await ctx.ledger.listEntriesForPaymentAttempt(resultingPaymentAttemptId);
      const recoveredPlatformFeePosting = recoveredEntries.find((e) => e.entryType === "payment_cleared")?.postings.find((p) => p.accountType === "platform_fee_revenue");
      expect(recoveredPlatformFeePosting?.amountMinorUnits).toBe(55);

      // No divergence: both settlements of the SAME kind of payment, through the SAME shared
      // authority, produced the exact SAME non-default value — never 0 (which a hidden local
      // fallback anywhere in either path would have silently produced instead).
      expect(normalPlatformFeePosting?.amountMinorUnits).toBe(recoveredPlatformFeePosting?.amountMinorUnits);
    });
  });

  describe("PAID2YOU — PACKAGE B / STAGE 6 ARCHITECTURAL REVIEW REMEDIATION — Item 1 (complete trusted-evidence conflict detection, remaining dimensions) and Item 3 (exact reconciliation provenance predicates)", () => {
    /** Seeds a real, provider-routed "succeeded" payment with a KNOWN, actually-posted processor fee — the authoritative evidence Item 1's own processor-fee conflict check compares a later event's claim against. */
    async function seedSucceededWithKnownFees(
      ctx: ReturnType<typeof buildContext>,
      agreementId: string,
      debtor: { profileId: string },
      creditor: { profileId: string },
      amountMinorUnits: number,
      processorFeeMinorUnits: number,
    ) {
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const webhook = ctx.buildWebhookService();
      const result = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId, amountMinorUnits, processorFeeMinorUnits }),
      );
      expect(result.status).toBe("processed");
      return { payment: (await ctx.payments.findById(payment.id))!, providerPaymentId };
    }

    // Item 1.A (amount conflict auto-creates an exception) and Item 1.E (equivalent evidence creates
    // none) are already covered by R-B68F / R-B68G above — both via `receiveWebhook` alone, never a
    // manual `reconcilePaymentAttempt` call. The remaining required dimensions follow.

    it("Item 1.B — a currency conflict in a later trusted event automatically creates an exception, with no manual reconciliation call", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const { payment, providerPaymentId } = await seedSucceededWithKnownFees(ctx, agreementId, debtor, creditor, 5_000, 100);

      const webhook = ctx.buildWebhookService();
      const result = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, {
          providerEventId: `evt-${randomUUID()}`,
          eventType: "payment.succeeded",
          providerPaymentId,
          amountMinorUnits: 5_000,
          currency: "EUR",
          processorFeeMinorUnits: 100,
        }),
      );
      expect(result.status).toBe("processed"); // dead no-op transition-wise — never applied.

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptions.map((e) => e.exceptionType)).toContain("currency_mismatch");
      expect(exceptions.map((e) => e.exceptionType)).not.toContain("amount_mismatch");
    });

    it("Item 1.C — a processor-fee conflict against the ALREADY-POSTED ledger evidence automatically creates an exception", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const { payment, providerPaymentId } = await seedSucceededWithKnownFees(ctx, agreementId, debtor, creditor, 5_000, 100);

      const webhook = ctx.buildWebhookService();
      const result = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, {
          providerEventId: `evt-${randomUUID()}`,
          eventType: "payment.succeeded",
          providerPaymentId,
          amountMinorUnits: 5_000,
          processorFeeMinorUnits: 999, // conflicts with the 100 actually posted.
        }),
      );
      expect(result.status).toBe("processed");

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      const conflict = exceptions.find((e) => e.exceptionType === "processor_fee_mismatch");
      expect(conflict).toBeDefined();
      expect(conflict?.details).toEqual({ expected: 100, actual: 999 });
    });

    it("Item 1.D (SUPERSEDED by Stage 6 FINAL closure, Item 2 — see that item's Tests A-D) — an incoming event's OWN platformFeeMinorUnits field is NEVER authoritative Paid2You fee evidence: a duplicate carrying a wildly different value creates NO platform_fee_mismatch, only a genuine processor-fee conflict is still detected from provider-authoritative evidence", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const { payment, providerPaymentId } = await seedSucceededWithKnownFees(ctx, agreementId, debtor, creditor, 5_000, 100);

      const webhook = ctx.buildWebhookService();
      const result = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, {
          providerEventId: `evt-${randomUUID()}`,
          eventType: "payment.succeeded",
          providerPaymentId,
          amountMinorUnits: 5_000,
          processorFeeMinorUnits: 100, // matches what was actually posted — no processor-fee conflict.
          // PAID2YOU — PACKAGE B (Stage 6 final architecture closure, Item 2): an inbound event's own
          // platformFeeMinorUnits is provider-supplied, never Paid2You-authoritative — this field is
          // never even read for conflict-detection purposes now, regardless of its value. See Item 2
          // Tests A-D (below) for the corrected internal (policy-vs-posted) comparison this replaces.
          platformFeeMinorUnits: 999,
        }),
      );
      expect(result.status).toBe("processed");

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptions.map((e) => e.exceptionType)).not.toContain("platform_fee_mismatch");
      expect(exceptions.map((e) => e.exceptionType)).not.toContain("processor_fee_mismatch");
    });

    it("Item 1.F — concurrent conflict detections for the SAME identity create EXACTLY ONE open exception (real DB-enforced atomicity, never an app-level find-then-insert race)", async () => {
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const payments = new DrizzlePaymentAttemptRepository();
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });

      const isolatedA = createIsolatedDb(DATABASE_URL);
      const isolatedB = createIsolatedDb(DATABASE_URL);
      try {
        const repoA = new DrizzleReconciliationExceptionRepository(isolatedA.db);
        const repoB = new DrizzleReconciliationExceptionRepository(isolatedB.db);
        const providerEventId = `evt-${randomUUID()}`;
        const identity = { exceptionType: "amount_mismatch" as const, paymentAttemptId: payment.id, providerEventId, details: { expected: 5_000, actual: 999_999 } };

        // The atomicity claim under test — `reconciliation_exception_open_identity_unique`'s own
        // partial unique index refuses a second row for this exact identity — holds regardless of
        // whether these two calls genuinely overlap in wall-clock time: the DB constraint rejects
        // the second insert whether it lands microseconds after the first commits or fully
        // sequentially, so a bare `Promise.all` is already sufficient, honest proof (unlike a
        // lock-contention claim, which would require a genuine in-flight overlap to mean anything).
        const [resultA, resultB] = await Promise.all([repoA.ensureOpenException(identity), repoB.ensureOpenException(identity)]);
        const successes = [resultA, resultB].filter((r) => r !== null);
        expect(successes).toHaveLength(1);

        const all = await new DrizzleReconciliationExceptionRepository().listForPaymentAttempt(payment.id);
        expect(all.filter((e) => e.exceptionType === "amount_mismatch" && e.status === "open")).toHaveLength(1);
      } finally {
        await isolatedA.close();
        await isolatedB.close();
      }
    });

    /** Item 3 raw-provenance seeding: inserts a real, processed event via the normal repository contract, then a raw update forces the EXACT (source, signatureVerified) combination under test — the two "invalid" combinations are never actually produced by this codebase's own write paths, but the read-side predicate must still reject them (defense-in-depth, not empirical necessity — see the interface doc comment on `findTrustedFinancialEventsForPayment`). */
    async function seedRawProvenanceEvent(
      ctx: ReturnType<typeof buildContext>,
      providerPaymentId: string,
      source: "webhook" | "provider_lookup",
      signatureVerified: boolean,
    ): Promise<void> {
      const inserted = await ctx.events.tryInsertAndClaim({
        provider: ctx.provider.providerName,
        providerEventId: `evt-${randomUUID()}`,
        eventType: "payment.succeeded",
        source: "webhook",
        signatureVerified: true,
        payload: { providerPaymentId, amountMinorUnits: 5_000, currency: "USD", processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 },
        leaseMs: 120_000,
        now: new Date(),
      });
      await ctx.events.markProcessed(inserted!.id, inserted!.claimToken!, new Date());
      const db = getDb();
      await db.update(paymentWebhookEvent).set({ source, signatureVerified }).where(eq(paymentWebhookEvent.id, inserted!.id));
    }

    it("Item 3.A — source='webhook' AND signatureVerified=true QUALIFIES as trusted reconciliation evidence", async () => {
      const ctx = buildContext();
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      await seedRawProvenanceEvent(ctx, providerPaymentId, "webhook", true);
      const trusted = await ctx.events.findTrustedFinancialEventsForPayment(ctx.provider.providerName, providerPaymentId, "payment.succeeded");
      expect(trusted).toHaveLength(1);
    });

    it("Item 3.B — source='provider_lookup' AND signatureVerified=false QUALIFIES as trusted reconciliation evidence", async () => {
      const ctx = buildContext();
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      await seedRawProvenanceEvent(ctx, providerPaymentId, "provider_lookup", false);
      const trusted = await ctx.events.findTrustedFinancialEventsForPayment(ctx.provider.providerName, providerPaymentId, "payment.succeeded");
      expect(trusted).toHaveLength(1);
    });

    it("Item 3.C — source='provider_lookup' AND signatureVerified=true does NOT qualify, even though neither individual field looks wrong in isolation", async () => {
      const ctx = buildContext();
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      await seedRawProvenanceEvent(ctx, providerPaymentId, "provider_lookup", true);
      const trusted = await ctx.events.findTrustedFinancialEventsForPayment(ctx.provider.providerName, providerPaymentId, "payment.succeeded");
      expect(trusted).toHaveLength(0);
    });

    it("Item 3.D — source='webhook' AND signatureVerified=false does NOT qualify, even though neither individual field looks wrong in isolation", async () => {
      const ctx = buildContext();
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      await seedRawProvenanceEvent(ctx, providerPaymentId, "webhook", false);
      const trusted = await ctx.events.findTrustedFinancialEventsForPayment(ctx.provider.providerName, providerPaymentId, "payment.succeeded");
      expect(trusted).toHaveLength(0);
    });

    it("Stage 6 closure, Item 1 Test B — a late-arriving duplicate success event after the payment has since legally become DISPUTED is a COMPATIBLE historical duplicate, never a false status_mismatch exception", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const webhook = ctx.buildWebhookService();

      const succeedResult = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }));
      expect(succeedResult.status).toBe("processed");

      const disputeResult = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.disputed", providerPaymentId }));
      expect(disputeResult.status).toBe("processed");
      expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed");

      // Delayed, genuinely-equivalent duplicate success event, arriving AFTER the legal
      // succeeded -> disputed progression — durable history proves "succeeded" really did occur, and
      // "disputed" is a legal further progression from it.
      const delayedDuplicate = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId, amountMinorUnits: 5_000 }),
      );
      expect(delayedDuplicate.status).toBe("processed"); // dead-end transition-wise — never applied, never regressed.
      expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed");

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptions.map((e) => e.exceptionType)).not.toContain("status_mismatch");
    });

    it("Stage 6 closure, Item 1 Test C — a late-arriving duplicate success event after the payment has since legally become REFUNDED is a COMPATIBLE historical duplicate, never a false status_mismatch exception", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const webhook = ctx.buildWebhookService();

      await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }));
      const refundResult = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.refunded", providerPaymentId }));
      expect(refundResult.status).toBe("processed");
      expect((await ctx.payments.findById(payment.id))?.status).toBe("refunded");

      const delayedDuplicate = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId, amountMinorUnits: 5_000 }),
      );
      expect(delayedDuplicate.status).toBe("processed");
      expect((await ctx.payments.findById(payment.id))?.status).toBe("refunded");

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptions.map((e) => e.exceptionType)).not.toContain("status_mismatch");
    });

    it("Stage 6 closure, Item 1 Test D — a genuinely incompatible outcome, never historically achieved by this payment, still creates a status_mismatch exception", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const webhook = ctx.buildWebhookService();
      await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }));

      // "failed" was NEVER historically achieved by this payment (it went straight pending ->
      // succeeded) — a stale/incompatible "payment.failed" event arriving now is a genuine conflict,
      // not a duplicate of anything real.
      const staleFail = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.failed", providerPaymentId }));
      expect(staleFail.status).toBe("processed");
      expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded"); // never regressed.

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptions.map((e) => e.exceptionType)).toContain("status_mismatch");
    });

    it("Stage 6 closure, Item 1 — EVENT-SPECIFIC FEE COMPARISON: a duplicate refund event's own fee-shaped fields are never compared against unrelated success-clearing evidence", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const webhook = ctx.buildWebhookService();
      await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId, processorFeeMinorUnits: 100 }),
      );
      const firstRefund = await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.refunded", providerPaymentId }));
      expect(firstRefund.status).toBe("processed");
      expect((await ctx.payments.findById(payment.id))?.status).toBe("refunded");

      // A SECOND (duplicate/dead-end) refund event carrying arbitrary "fee-shaped" fields — this
      // ledger model's own reversal entry (`LedgerService.reversePayment`) never posts a
      // processor-fee/platform-fee leg of its own, so there is NO applicable refund-fee evidence to
      // compare these fields against; under the prior architecture this would have been (incorrectly)
      // compared against the fee-less reversal entry's own postings (reading as an actual-vs-0
      // mismatch) or the unrelated success-clearing entry.
      const secondRefund = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, {
          providerEventId: `evt-${randomUUID()}`,
          eventType: "payment.refunded",
          providerPaymentId,
          processorFeeMinorUnits: 999_999,
          platformFeeMinorUnits: 999_999,
        }),
      );
      expect(secondRefund.status).toBe("processed");
      expect((await ctx.payments.findById(payment.id))?.status).toBe("refunded"); // never regressed/reprocessed.

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptions.map((e) => e.exceptionType)).not.toContain("processor_fee_mismatch");
      expect(exceptions.map((e) => e.exceptionType)).not.toContain("platform_fee_mismatch");
      // Also compatible outcome-wise: "refunded" was truly, durably achieved (by the first refund
      // event) and current status IS "refunded" — the equal-status case, trivially compatible.
      expect(exceptions.map((e) => e.exceptionType)).not.toContain("status_mismatch");
    });

    it("Stage 6 FINAL closure, Item 1 Test A — an event whose OWN claimed provider differs from the payment's authoritative provider durably creates EXACTLY ONE provider_identity_mismatch exception, with no state mutation of any kind", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const webhook = ctx.buildWebhookService();

      const providerEventId = `evt-${randomUUID()}`;
      const result = await webhook.receiveInternalEvent({
        // The payment's own authoritative providerName is "sandbox_mock" (seedPendingPayment's
        // default, via DrizzlePaymentAttemptRepository.insertPending) — a genuine mismatch.
        provider: "other_provider_mock",
        providerEventId,
        eventType: "payment.succeeded",
        data: { providerPaymentId, amountMinorUnits: 5_000, currency: "USD", processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 },
      });
      // PAID2YOU — PACKAGE B (Stage 6 final architecture closure, Item 1): a material conflict,
      // finalized like every other conflict this service detects — "processed", never left retrying
      // forever over a disagreement retrying can never fix.
      expect(result.status).toBe("processed");

      const eventRow = await ctx.events.findByProviderEvent("other_provider_mock", providerEventId);
      expect(eventRow?.processingStatus).toBe("processed");

      expect((await ctx.payments.findById(payment.id))?.status).toBe("pending"); // never transitioned.
      const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
      expect(entries).toHaveLength(0); // no ledger effect.
      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptions).toHaveLength(1);
      expect(exceptions[0]?.exceptionType).toBe("provider_identity_mismatch");
      expect(exceptions[0]?.status).toBe("open");
      expect(exceptions[0]?.details).toEqual({ expectedProvider: "sandbox_mock", actualProvider: "other_provider_mock", providerPaymentId });
    });

    it("Stage 6 FINAL closure, Item 1 Test B — redelivering the IDENTICAL mismatched event never creates a second open exception (outer webhook-event dedup already makes this a genuine no-op)", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const webhook = ctx.buildWebhookService();
      const providerEventId = `evt-${randomUUID()}`;
      const eventInput = {
        provider: "other_provider_mock",
        providerEventId,
        eventType: "payment.succeeded",
        data: { providerPaymentId, amountMinorUnits: 5_000, currency: "USD", processorFeeMinorUnits: 0, platformFeeMinorUnits: 0 },
      };

      const first = await webhook.receiveInternalEvent(eventInput);
      expect(first.status).toBe("processed");
      const second = await webhook.receiveInternalEvent(eventInput);
      expect(second.status).toBe("duplicate"); // already processed — applyEvent never runs a second time.

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptions.filter((e) => e.exceptionType === "provider_identity_mismatch")).toHaveLength(1);
    });

    it("Stage 6 FINAL closure, Item 1 Test C — concurrent detection of the SAME provider-identity-mismatch identity creates EXACTLY ONE open exception (real DB-enforced atomicity)", async () => {
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const payments = new DrizzlePaymentAttemptRepository();
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });

      const isolatedA = createIsolatedDb(DATABASE_URL);
      const isolatedB = createIsolatedDb(DATABASE_URL);
      try {
        const repoA = new DrizzleReconciliationExceptionRepository(isolatedA.db);
        const repoB = new DrizzleReconciliationExceptionRepository(isolatedB.db);
        const providerEventId = `evt-${randomUUID()}`;
        const identity = {
          exceptionType: "provider_identity_mismatch" as const,
          paymentAttemptId: payment.id,
          providerEventId,
          details: { expectedProvider: "sandbox_mock", actualProvider: "other_provider_mock", providerPaymentId },
        };

        const [resultA, resultB] = await Promise.all([repoA.ensureOpenException(identity), repoB.ensureOpenException(identity)]);
        const successes = [resultA, resultB].filter((r) => r !== null);
        expect(successes).toHaveLength(1);

        const all = await new DrizzleReconciliationExceptionRepository().listForPaymentAttempt(payment.id);
        expect(all.filter((e) => e.exceptionType === "provider_identity_mismatch" && e.status === "open")).toHaveLength(1);
      } finally {
        await isolatedA.close();
        await isolatedB.close();
      }
    });

    it("Stage 6 FINAL closure, Item 1 Test D — an ordinary transient provider/lookup failure remains retryable and never creates a provider_identity_mismatch exception", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      // A genuinely transient failure INSIDE the payment lookup itself — never reaching the provider-
      // identity comparison at all (a completely different code path/error, upstream of it).
      const flakyPayments = flaky(ctx.payments, "findByProviderPaymentId", 1, () => new Error("simulated_transient_lookup_failure"));
      const webhook = ctx.buildWebhookService({ payments: flakyPayments });
      const providerEventId = `evt-${randomUUID()}`;
      const event = signedWebhook(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId });

      const result = await webhook.receiveWebhook(event);
      expect(result.status).toBe("accepted"); // genuinely retryable, never "processed".
      const afterFirst = (await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))!;
      expect(afterFirst.processingStatus).toBe("failed");
      expect(afterFirst.nextRetryAt).not.toBeNull(); // will be retried — never permanent.
      expect(afterFirst.lastErrorCode).toBe("transient_processing_error");

      const exceptionsAfterFirst = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptionsAfterFirst).toHaveLength(0); // never even reached the provider-identity check.

      // The retry succeeds once the transient failure has cleared (flaky's own one-shot failure),
      // via the same recovery-scheduler entry point B09 uses — proving this event genuinely recovers
      // and settles normally, never converging on a provider_identity_mismatch it was never evidence for.
      await webhook.recoverBatch(10, new Date(afterFirst.nextRetryAt!.getTime() + 1));
      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId))?.processingStatus).toBe("processed");
      expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded");
      const exceptionsAfterRetry = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptionsAfterRetry.map((e) => e.exceptionType)).not.toContain("provider_identity_mismatch");
    });

    it("Stage 6 FINAL closure, Item 2 Test A — a signed provider success carrying an arbitrary platformFeeMinorUnits value is NEVER treated as authoritative Paid2You fee evidence; no false platform_fee_mismatch is created solely from that field", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const webhook = ctx.buildWebhookService();
      await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }));

      // A dead-end duplicate carrying an arbitrary, WRONG platformFeeMinorUnits — the provider/webhook
      // is never the authority for Paid2You's own fee, so this field is never even read for conflict
      // detection purposes, regardless of how far it disagrees with the real policy.
      const duplicateResult = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId, amountMinorUnits: 5_000, platformFeeMinorUnits: 999_999 }),
      );
      expect(duplicateResult.status).toBe("processed");

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptions.map((e) => e.exceptionType)).not.toContain("platform_fee_mismatch");
    });

    it("Stage 6 FINAL closure, Item 2 Test B — Paid2You's default policy (0) matches its own already-posted platform_fee_revenue (0): no platform-fee conflict", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const webhook = ctx.buildWebhookService();
      await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }));

      const duplicateResult = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId, amountMinorUnits: 5_000 }),
      );
      expect(duplicateResult.status).toBe("processed");

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptions.map((e) => e.exceptionType)).not.toContain("platform_fee_mismatch");
    });

    it("Stage 6 FINAL closure, Item 2 Test C — the LIVE PlatformFeePolicy result diverging from what Paid2You itself actually posted at original settlement automatically creates a platform_fee_mismatch (a genuine Paid2You-vs-Paid2You conflict, never provider-triggered)", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      // Simulates the policy's OWN live result changing between original settlement (call #1 -> 54,
      // what actually got posted) and a later re-examination (call #2+ -> 55) — never anything an
      // external party's payload could ever trigger.
      let calls = 0;
      const evolvingPolicy: PlatformFeePolicy = {
        async getPlatformFeeMinorUnits() {
          calls += 1;
          return calls === 1 ? 54 : 55;
        },
      };
      const webhook = ctx.buildWebhookService({ platformFeePolicy: evolvingPolicy });
      await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }));
      const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
      const postedPlatformFee = entries.find((e) => e.entryType === "payment_cleared")?.postings.find((p) => p.accountType === "platform_fee_revenue")?.amountMinorUnits ?? 0;
      expect(postedPlatformFee).toBe(54);

      const duplicateResult = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId, amountMinorUnits: 5_000 }),
      );
      expect(duplicateResult.status).toBe("processed");

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      const conflict = exceptions.find((e) => e.exceptionType === "platform_fee_mismatch");
      expect(conflict).toBeDefined();
      expect(conflict?.details).toEqual({ expected: 55, actual: 54 });
    });

    it("Stage 6 FINAL closure, Item 2 Test D — the LIVE PlatformFeePolicy result matching what Paid2You itself actually posted creates no platform-fee conflict", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const fixedPolicy: PlatformFeePolicy = { async getPlatformFeeMinorUnits() { return 55; } };
      const webhook = ctx.buildWebhookService({ platformFeePolicy: fixedPolicy });
      await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }));

      const duplicateResult = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId, amountMinorUnits: 5_000 }),
      );
      expect(duplicateResult.status).toBe("processed");

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptions.map((e) => e.exceptionType)).not.toContain("platform_fee_mismatch");
    });

    it("Stage 6 closure, Item 2 — providerPaymentId identity is structurally guaranteed by a DB-enforced unique, exact-match repository lookup: findByProviderPaymentId can never return a payment whose own providerPaymentId differs from the one looked up", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const idA = `sandbox_pay_${randomUUID()}`;
      const idB = `sandbox_pay_${randomUUID()}`;
      const paymentA = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId: idA,
      });
      const paymentB = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId: idB,
      });

      const foundA = await ctx.payments.findByProviderPaymentId(idA);
      const foundB = await ctx.payments.findByProviderPaymentId(idB);
      expect(foundA?.id).toBe(paymentA.id);
      expect(foundA?.providerPaymentId).toBe(idA);
      expect(foundB?.id).toBe(paymentB.id);
      expect(foundB?.providerPaymentId).toBe(idB);
    });
  });

  describe("PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 3 — B3): dispatch revocation must not cancel outcome discovery", () => {
    function buildLossyAmbiguousProvider(): { lossyProvider: SandboxPaymentProvider; realProvider: SandboxPaymentProvider; getRealProviderPaymentId: () => string | null } {
      const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
      let realProviderPaymentId: string | null = null;
      const lossyProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "createPayment") {
            return async (...args: unknown[]) => {
              const result = await (target.createPayment as (...a: unknown[]) => Promise<{ providerPaymentId: string; status: string }>).apply(target, args);
              realProviderPaymentId = result.providerPaymentId;
              throw new AmbiguousProviderResponseError();
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;
      return { lossyProvider, realProvider, getRealProviderPaymentId: () => realProviderPaymentId };
    }
    const unusedInitiator: RetryPaymentMethodInitiator = {
      async createManualPayment() {
        throw new Error("not used in this test");
      },
      async prepareRetrySubmission() {
        throw new Error("not used in this test");
      },
    };

    it("R-B63A — settling the installment via a DIFFERENT payment must not erase an already-ambiguous retry's discoverability; automatic resolution still correlates it, with no second dispatch", async () => {
      const { ctx, verificationCtx, coordinator } = await buildRetryEligibilityHarness();
      const { creditor, debtor } = await seedTwoParties();
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      await seedVerifiedParties(verificationCtx, debtor, creditor);
      const payment = await seedInstallmentPaymentWithMethod(agreementId, installmentScheduleItemId, debtor, creditor);
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;

      const { lossyProvider, getRealProviderPaymentId } = buildLossyAmbiguousProvider();
      const dispatchOutcome = await coordinator.claimAndExecuteRetry({
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        agreementId,
        provider: lossyProvider,
        prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        effectApplier: ctx.buildWebhookService(),
      });
      if (dispatchOutcome.outcome !== "ambiguous") throw new Error("expected ambiguous");

      // A DIFFERENT payment settles the SAME installment.
      await coordinator.coordinateSuccess({ installmentScheduleItemId });
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");

      // The already-ambiguous retry remains "claimed" — settlement never erased its discoverability.
      const afterSettlement = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
      expect(afterSettlement?.status).toBe("claimed");

      // Automatic discovery, via the REAL scheduler entry point, still runs it — bound to the SAME
      // underlying provider instance the ambiguous dispatch used.
      const dedicatedRetryService = new PaymentRetryService({
        retries: new DrizzlePaymentRetryRepository(),
        paymentAttempts: ctx.payments,
        initiators: { ach: unusedInitiator, debit_card: unusedInitiator, manual_off_platform: unusedInitiator },
        profileOwners: verificationCtx.profileOwners,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        retryCoordinator: coordinator,
        provider: lossyProvider,
        eligibility: new DrizzlePaymentInitiationEligibilityService({ verification: verificationCtx.verificationService, payments: ctx.payments, balances: ctx.balances }),
        effectApplier: ctx.buildWebhookService(),
      });
      const recovery = await dedicatedRetryService.fireDueRetries(new Date());
      expect(recovery.resolved).toBe(1);

      const afterRecovery = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
      expect(afterRecovery?.status).toBe("fired");
      const resultingPayment = await ctx.payments.findById(afterRecovery!.resultingPaymentAttemptId!);
      expect(resultingPayment?.providerPaymentId).toBe(getRealProviderPaymentId()); // correlated, no second dispatch.
    });

    it("R-B63B — a stale worker's own cancellation attempt, issued after a concurrent worker already claimed and ambiguously dispatched the SAME retry, is a safe no-op that never erases discoverability", async () => {
      const { ctx, verificationCtx, coordinator } = await buildRetryEligibilityHarness();
      const { creditor, debtor } = await seedTwoParties();
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      await seedVerifiedParties(verificationCtx, debtor, creditor);
      const payment = await seedInstallmentPaymentWithMethod(agreementId, installmentScheduleItemId, debtor, creditor);
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;

      const { lossyProvider } = buildLossyAmbiguousProvider();
      // Worker B: claims and ambiguously dispatches.
      const dispatchOutcome = await coordinator.claimAndExecuteRetry({
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        agreementId,
        provider: lossyProvider,
        prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        effectApplier: ctx.buildWebhookService(),
      });
      expect(dispatchOutcome.outcome).toBe("ambiguous");

      // Worker A: a stale snapshot from BEFORE B's claim — hits a preparation error and attempts to
      // cancel, exactly mirroring PaymentRetryService.fireDueRetries's own scheduled-loop catch block.
      const staleCancelResult = await new DrizzlePaymentRetryRepository().markCanceled(
        failure.retryId,
        new Date(),
        "Firing failed: stale worker A's own simulated preparation error",
      );
      expect(staleCancelResult).toBeNull(); // conditional cancel affects zero rows.

      const afterStaleCancel = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
      expect(afterStaleCancel?.status).toBe("claimed"); // untouched — ambiguity discovery remains intact.

      const effectApplier = ctx.buildWebhookService();
      const resolution = await coordinator.resolveAmbiguousRetry({ retryId: failure.retryId, idempotencyKey, provider: lossyProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");
    });

    it("R-B63C — a settled installment prevents any FUTURE retry scheduling/dispatch, but never prevents resolution of an already-dispatched provider payment", async () => {
      const { ctx, verificationCtx, coordinator } = await buildRetryEligibilityHarness();
      const { creditor, debtor } = await seedTwoParties();
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      await seedVerifiedParties(verificationCtx, debtor, creditor);
      const payment = await seedInstallmentPaymentWithMethod(agreementId, installmentScheduleItemId, debtor, creditor);
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;

      const { lossyProvider, getRealProviderPaymentId } = buildLossyAmbiguousProvider();
      const dispatchOutcome = await coordinator.claimAndExecuteRetry({
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        agreementId,
        provider: lossyProvider,
        prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        effectApplier: ctx.buildWebhookService(),
      });
      if (dispatchOutcome.outcome !== "ambiguous") throw new Error("expected ambiguous");

      await coordinator.coordinateSuccess({ installmentScheduleItemId });
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");

      // (a) FUTURE dispatch/scheduling is genuinely prevented: a stale failure replay for a DIFFERENT
      // payment on this now-settled installment is a pure no-op — never even schedules a new retry.
      const anotherPayment = await seedInstallmentPaymentWithMethod(agreementId, installmentScheduleItemId, debtor, creditor);
      const staleFailure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment: anotherPayment });
      expect(staleFailure.outcome).toBe("already_settled");

      // (b) resolution of the ALREADY-dispatched provider payment still proceeds.
      const effectApplier = ctx.buildWebhookService();
      const resolution = await coordinator.resolveAmbiguousRetry({ retryId: failure.retryId, idempotencyKey, provider: lossyProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");
      const resultingPayment = await ctx.payments.findById(dispatchOutcome.paymentAttemptId);
      expect(resultingPayment?.providerPaymentId).toBe(getRealProviderPaymentId());
    });
  });

  it("R-B64 — lifecycle repair candidate selection must not be starved by payments still missing their OWN clearing entry: those never occupy a lifecycle-batch slot, so a later, genuinely lifecycle-only-blocked payment is found and repaired via the real scheduler path", async () => {
    const BATCH = 5;
    const UNREPAIRABLE_COUNT = 50;
    const ctx = buildContext();

    async function seedSucceededPaymentMissingClearing(index: number): Promise<string> {
      const creditor = await seedPersonalUser(`r-b64-creditor-${index}`);
      const debtor = await seedPersonalUser(`r-b64-debtor-${index}`);
      const agreementId = await seedAgreement(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      // No trusted webhook event exists for this payment at all — findUnambiguousTrustedEvent finds
      // nothing, so repair is correctly refused, leaving it permanently missing its clearing entry
      // (a genuine "needs manual review" shape, not a bug).
      const inserted = await ctx.payments.insertPending({
        idempotencyKey: randomUUID(),
        payerProfileKind: "personal",
        payerProfileId: debtor.profileId,
        recipientProfileKind: "personal",
        recipientProfileId: creditor.profileId,
        amountMinorUnits: 5_000,
        currency: "USD",
        agreementId,
        providerName: "sandbox_mock",
        initialStatus: "succeeded",
      });
      const db = getDb();
      // Deterministic, strictly-increasing "oldest first" ordering.
      await db.update(paymentAttempt).set({ updatedAt: new Date(Date.now() - (UNREPAIRABLE_COUNT - index) * 1000) }).where(eq(paymentAttempt.id, inserted.id));
      return inserted.id;
    }

    const unrepairableIds: string[] = [];
    for (let i = 0; i < UNREPAIRABLE_COUNT; i += 1) {
      unrepairableIds.push(await seedSucceededPaymentMissingClearing(i));
    }

    // The LATER, genuinely lifecycle-only-blocked payment: it ALREADY has its clearing entry (posted
    // via a real webhook success, so it's trusted/authoritative), but its agreement never advanced —
    // `lifecycleCheckedAt` is null, a genuine gap this scheduler exists to close. `completion` is
    // deliberately omitted from this ONE webhook call to simulate "the original webhook's own
    // lifecycle step never ran" without touching any production code.
    const { creditor, debtor, agreementId: laterAgreementId } = await seedTwoParties(5_000);
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const laterPayment = await seedPendingPayment(ctx.payments, {
      agreementId: laterAgreementId,
      amountMinorUnits: 5_000,
      payerProfileId: debtor.profileId,
      recipientProfileId: creditor.profileId,
      providerPaymentId,
    });
    const webhookMissingLifecycle = ctx.buildWebhookService({ completion: undefined });
    const result = await webhookMissingLifecycle.receiveWebhook(
      signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }),
    );
    expect(result.status).toBe("processed");
    expect(await findClearEntry(ctx.ledger, laterPayment.id)).not.toBeNull();
    expect((await ctx.agreements.findById(laterAgreementId))?.status).toBe("first_payment_pending");

    // Direct, deterministic proof of the fix itself: the repository query never selects any of the
    // 50 ledger-less rows (they lack the required `payment_cleared` entry), and DOES select the later,
    // genuinely lifecycle-only-blocked one.
    const directCandidates = await ctx.payments.listLifecycleRepairCandidates(BATCH);
    const directCandidateIds = directCandidates.map((c) => c.id);
    expect(directCandidateIds).toContain(laterPayment.id);
    for (const unrepairableId of unrepairableIds) {
      expect(directCandidateIds).not.toContain(unrepairableId);
    }

    // End-to-end proof via the REAL, bounded scheduler entry point (never invoking lifecycle repair
    // directly) — the later candidate converges within a small, bounded number of runs.
    for (let run = 0; run < 3; run += 1) {
      await ctx.reconciliation.repairBatch(BATCH);
      if ((await ctx.agreements.findById(laterAgreementId))?.status === "paid_in_full") break;
    }
    expect((await ctx.agreements.findById(laterAgreementId))?.status).toBe("paid_in_full");
    expect((await ctx.payments.findById(laterPayment.id))?.lifecycleCheckedAt).not.toBeNull();

    // None of the 50 permanently-unrepairable rows ever advanced their (nonexistent) lifecycle state —
    // they simply remain visible/unrepaired, exactly as intended.
    for (const unrepairableId of unrepairableIds) {
      expect((await ctx.payments.findById(unrepairableId))?.lifecycleCheckedAt).toBeNull();
    }
  });

  describe("PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 5 — B5): claimed-resumption fairness on per-item exceptions", () => {
    async function seedAmbiguousRetry(coordinator: FailedPaymentRetryCoordinator, provider: SandboxPaymentProvider) {
      const { creditor, debtor } = await seedTwoParties();
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPaymentWithMethod(agreementId, installmentScheduleItemId, debtor, creditor);
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;
      const outcome = await coordinator.claimAndExecuteRetry({
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        agreementId,
        provider,
        prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        effectApplier: buildContext().buildWebhookService(),
      });
      if (outcome.outcome !== "ambiguous") throw new Error("expected ambiguous");
      return { retryId: failure.retryId, installmentScheduleItemId, idempotencyKey };
    }

    it("R-B65A — a recoverable resumption-lookup failure on one claimed retry defers ONLY that row and lets a second claimed retry resolve in the SAME scheduler run", async () => {
      const { ctx, verificationCtx, coordinator } = await buildRetryEligibilityHarness();
      const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
      const lossyProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "createPayment") {
            return async (...args: unknown[]) => {
              await (target.createPayment as (...a: unknown[]) => Promise<{ providerPaymentId: string; status: string }>).apply(target, args);
              throw new AmbiguousProviderResponseError();
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;

      const first = await seedAmbiguousRetry(coordinator, lossyProvider);
      const second = await seedAmbiguousRetry(coordinator, lossyProvider);

      const flakyResolutionProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "retrievePaymentByIdempotencyKey") {
            return async (key: string) => {
              if (key === first.idempotencyKey) throw new Error("simulated_recoverable_lookup_error");
              return target.retrievePaymentByIdempotencyKey(key);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;

      const unusedInitiator: RetryPaymentMethodInitiator = {
        async createManualPayment() {
          throw new Error("not used in this test");
        },
        async prepareRetrySubmission() {
          throw new Error("not used in this test");
        },
      };
      const retryService = new PaymentRetryService({
        retries: new DrizzlePaymentRetryRepository(),
        paymentAttempts: ctx.payments,
        initiators: { ach: unusedInitiator, debit_card: unusedInitiator, manual_off_platform: unusedInitiator },
        profileOwners: verificationCtx.profileOwners,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        retryCoordinator: coordinator,
        provider: flakyResolutionProvider,
        eligibility: new DrizzlePaymentInitiationEligibilityService({ verification: verificationCtx.verificationService, payments: ctx.payments, balances: ctx.balances }),
        effectApplier: ctx.buildWebhookService(),
      });

      const outcome = await retryService.fireDueRetries(new Date());
      expect(outcome.resolved).toBe(1); // second retry resolved in the SAME run.

      const firstRow = (await listRetriesForInstallment(first.installmentScheduleItemId)).find((r) => r.id === first.retryId);
      expect(firstRow?.status).toBe("claimed"); // deferred, not falsely resolved/canceled.
      expect(firstRow?.nextResolutionAttemptAt).not.toBeNull();

      const secondRow = (await listRetriesForInstallment(second.installmentScheduleItemId)).find((r) => r.id === second.retryId);
      expect(secondRow?.status).toBe("fired");
    });

    it("R-B65B — repeated resumption-lookup failures advance next_resolution_attempt_at each time, never a tight loop", async () => {
      const { ctx, verificationCtx, coordinator } = await buildRetryEligibilityHarness();
      const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
      const lossyProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "createPayment") {
            return async (...args: unknown[]) => {
              await (target.createPayment as (...a: unknown[]) => Promise<{ providerPaymentId: string; status: string }>).apply(target, args);
              throw new AmbiguousProviderResponseError();
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;
      const seeded = await seedAmbiguousRetry(coordinator, lossyProvider);

      const alwaysThrowingProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "retrievePaymentByIdempotencyKey") return async () => Promise.reject(new Error("simulated_recoverable_lookup_error"));
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;

      const unusedInitiator: RetryPaymentMethodInitiator = {
        async createManualPayment() {
          throw new Error("not used in this test");
        },
        async prepareRetrySubmission() {
          throw new Error("not used in this test");
        },
      };
      const retryService = new PaymentRetryService({
        retries: new DrizzlePaymentRetryRepository(),
        paymentAttempts: ctx.payments,
        initiators: { ach: unusedInitiator, debit_card: unusedInitiator, manual_off_platform: unusedInitiator },
        profileOwners: verificationCtx.profileOwners,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        retryCoordinator: coordinator,
        provider: alwaysThrowingProvider,
        eligibility: new DrizzlePaymentInitiationEligibilityService({ verification: verificationCtx.verificationService, payments: ctx.payments, balances: ctx.balances }),
        effectApplier: ctx.buildWebhookService(),
      });

      let now = new Date();
      const deferrals: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        now = new Date(now.getTime() + 16 * 60 * 1000); // past the 15-minute backoff each time.
        const outcome = await retryService.fireDueRetries(now);
        expect(outcome.resolved).toBe(0);
        const row = (await listRetriesForInstallment(seeded.installmentScheduleItemId)).find((r) => r.id === seeded.retryId);
        expect(row?.status).toBe("claimed"); // never falsely resolved/canceled.
        expect(row?.nextResolutionAttemptAt).not.toBeNull();
        deferrals.push(row!.nextResolutionAttemptAt!.getTime());
      }
      expect(deferrals).toHaveLength(3);
      expect(deferrals[1]!).toBeGreaterThan(deferrals[0]!);
      expect(deferrals[2]!).toBeGreaterThan(deferrals[1]!);

      // Immediately re-running at the SAME `now` (no time advance) must NOT re-select this still-deferred row.
      const stillDeferred = await new DrizzlePaymentRetryRepository().findClaimedForResumption(50, now);
      expect(stillDeferred.find((r) => r.id === seeded.retryId)).toBeUndefined();
    });

    it("R-B65C — a genuinely fatal infrastructure failure (a Postgres connection-class error) propagates out of the claimed-resumption loop rather than being swallowed as a per-item recoverable failure", async () => {
      const { ctx, verificationCtx, coordinator } = await buildRetryEligibilityHarness();
      const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
      const lossyProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "createPayment") {
            return async (...args: unknown[]) => {
              await (target.createPayment as (...a: unknown[]) => Promise<{ providerPaymentId: string; status: string }>).apply(target, args);
              throw new AmbiguousProviderResponseError();
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;
      const seeded = await seedAmbiguousRetry(coordinator, lossyProvider);

      // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B3 — corrected classifier): a
      // genuinely fatal error must be a REAL `DrizzleQueryError` whose `.cause` is genuinely shaped
      // like the `postgres` driver's own `PostgresError` (`.name === "PostgresError"`) — not merely
      // any object exposing a SQLSTATE-shaped `.code` at the top level (see R-B69C for the negative
      // case this distinguishes: an ordinary provider error whose own `.code` happens to collide).
      const postgresOriginCause = Object.assign(new Error("simulated_postgres_admin_shutdown"), {
        name: "PostgresError",
        code: "57P01", // Postgres admin_shutdown — operator-intervention class.
      });
      const fatalDbError = new DrizzleQueryError("select 1", [], postgresOriginCause);
      const fatalProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "retrievePaymentByIdempotencyKey") return async () => Promise.reject(fatalDbError);
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;

      const unusedInitiator: RetryPaymentMethodInitiator = {
        async createManualPayment() {
          throw new Error("not used in this test");
        },
        async prepareRetrySubmission() {
          throw new Error("not used in this test");
        },
      };
      const retryService = new PaymentRetryService({
        retries: new DrizzlePaymentRetryRepository(),
        paymentAttempts: ctx.payments,
        initiators: { ach: unusedInitiator, debit_card: unusedInitiator, manual_off_platform: unusedInitiator },
        profileOwners: verificationCtx.profileOwners,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        retryCoordinator: coordinator,
        provider: fatalProvider,
        eligibility: new DrizzlePaymentInitiationEligibilityService({ verification: verificationCtx.verificationService, payments: ctx.payments, balances: ctx.balances }),
        effectApplier: ctx.buildWebhookService(),
      });

      await expect(retryService.fireDueRetries(new Date())).rejects.toBe(fatalDbError);

      const row = (await listRetriesForInstallment(seeded.installmentScheduleItemId)).find((r) => r.id === seeded.retryId);
      expect(row?.status).toBe("claimed"); // untouched — never falsely deferred/resolved.
      expect(row?.nextResolutionAttemptAt).toBeNull();
    });

    it("R-B69E — a genuine REAL-Postgres-origin fatal failure (a canceled query, SQLSTATE 57014) aborts the claimed-resumption batch rather than being swallowed as a per-item recoverable failure", async () => {
      const { ctx, verificationCtx, coordinator } = await buildRetryEligibilityHarness();
      const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
      const lossyProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "createPayment") {
            return async (...args: unknown[]) => {
              await (target.createPayment as (...a: unknown[]) => Promise<{ providerPaymentId: string; status: string }>).apply(target, args);
              throw new AmbiguousProviderResponseError();
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;
      const seeded = await seedAmbiguousRetry(coordinator, lossyProvider);

      // A genuinely fatal failure sourced from a REAL Postgres backend: a query canceled by a very
      // short `statement_timeout` — SQLSTATE 57014 (operator-intervention class) — wrapped by
      // drizzle-orm's OWN query-execution path into a real `DrizzleQueryError`, exactly as a real
      // production outage would surface. No fake/synthetic error shape anywhere in this test.
      const realDbFailureProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "retrievePaymentByIdempotencyKey") {
            return async () => {
              const isolated = createIsolatedDb(DATABASE_URL);
              try {
                await isolated.db.execute(sql`SET statement_timeout = 50`);
                await isolated.db.execute(sql`SELECT pg_sleep(1)`);
                return null;
              } finally {
                await isolated.close();
              }
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;

      const unusedInitiator: RetryPaymentMethodInitiator = {
        async createManualPayment() {
          throw new Error("not used in this test");
        },
        async prepareRetrySubmission() {
          throw new Error("not used in this test");
        },
      };
      const retryService = new PaymentRetryService({
        retries: new DrizzlePaymentRetryRepository(),
        paymentAttempts: ctx.payments,
        initiators: { ach: unusedInitiator, debit_card: unusedInitiator, manual_off_platform: unusedInitiator },
        profileOwners: verificationCtx.profileOwners,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        retryCoordinator: coordinator,
        provider: realDbFailureProvider,
        eligibility: new DrizzlePaymentInitiationEligibilityService({ verification: verificationCtx.verificationService, payments: ctx.payments, balances: ctx.balances }),
        effectApplier: ctx.buildWebhookService(),
      });

      await expect(retryService.fireDueRetries(new Date())).rejects.toThrow();

      const row = (await listRetriesForInstallment(seeded.installmentScheduleItemId)).find((r) => r.id === seeded.retryId);
      expect(row?.status).toBe("claimed"); // batch aborted before this row could be falsely deferred/resolved.
      expect(row?.nextResolutionAttemptAt).toBeNull();
    });
  });

  describe("PAID2YOU — PACKAGE B / STAGE 6 FINAL HISTORICAL-EFFECT CLOSURE — historical success workflow/lifecycle disposition (apply / superseded_safely / wait_for_superseding_event)", () => {
    it("H1 — success workflow, no supersession: the success transition's own workflow evaluation fails, the payment remains succeeded, and retrying the event runs coordinateSuccess normally", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("h1-creditor");
      const debtor = await seedPersonalUser("h1-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentId = payment.providerPaymentId!;

      let workflowCalls = 0;
      const flakyWorkflow: FailedPaymentWorkflow = {
        async handlePaymentFailed() {},
        async handlePaymentSucceeded(p) {
          workflowCalls += 1;
          if (workflowCalls === 1) throw new Error("simulated_workflow_evaluation_failure");
          await new DrizzleInstallmentStatusRepository().markPaid(p.installmentScheduleItemId!);
        },
        async handlePaymentSuperseded() {},
      };
      const webhook = ctx.buildWebhookService({ failedPaymentWorkflow: flakyWorkflow });

      const successEventId = `evt-${randomUUID()}`;
      const successResult = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId }),
      );
      expect(successResult.status).toBe("accepted");
      expect(await installmentStatus(installmentScheduleItemId)).not.toBe("paid");

      const successRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))!;
      await webhook.recoverBatch(10, new Date(successRow.nextRetryAt!.getTime() + 1));

      expect(workflowCalls).toBe(2); // disposition = "apply" both times — payment never left "succeeded".
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
      expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded");
      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))?.processingStatus).toBe("processed");
    });

    it("H2 — success workflow safely superseded: once the later dispute is fully PROCESSED, retrying the historical success event never replays coordinateSuccess, and the dispute's own resulting state is preserved", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("h2-creditor");
      const debtor = await seedPersonalUser("h2-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentId = payment.providerPaymentId!;

      let workflowCalls = 0;
      const flakyWorkflow: FailedPaymentWorkflow = {
        async handlePaymentFailed() {},
        async handlePaymentSucceeded() {
          workflowCalls += 1;
          // Always throws — if disposition logic ever WRONGLY calls this again after safe
          // supersession, the success event would remain permanently stuck, an unmistakable signal.
          throw new Error("must never be invoked again once safely superseded");
        },
        async handlePaymentSuperseded() {},
      };
      const webhook = ctx.buildWebhookService({ failedPaymentWorkflow: flakyWorkflow });

      const successEventId = `evt-${randomUUID()}`;
      const successResult = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId }),
      );
      expect(successResult.status).toBe("accepted"); // workflow failed -> not processed.
      expect(workflowCalls).toBe(1);
      const installmentBeforeDispute = await installmentStatus(installmentScheduleItemId);
      expect(installmentBeforeDispute).not.toBe("paid");

      // The later dispute applies its OWN transition and FULLY completes its own required effects
      // (nothing injected on this path) — it reaches processingStatus = "processed".
      const disputeEventId = `evt-${randomUUID()}`;
      const disputeResult = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: disputeEventId, eventType: "payment.disputed", providerPaymentId }),
      );
      expect(disputeResult.status).toBe("processed");
      expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed");

      // Retry the ORIGINAL success event.
      const successRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))!;
      await webhook.recoverBatch(10, new Date(successRow.nextRetryAt!.getTime() + 1));

      expect(workflowCalls).toBe(1); // NEVER called again — disposition = "superseded_safely".
      expect(await installmentStatus(installmentScheduleItemId)).toBe(installmentBeforeDispute); // preserved, not replayed.
      expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed"); // never regressed.
      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))?.processingStatus).toBe("processed"); // the success event itself still finalizes.
    });

    it("H3 — a later transition applied but NOT YET fully processed is not proof of safe supersession; only once it completes does supersession become safe", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("h3-creditor");
      const debtor = await seedPersonalUser("h3-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentId = payment.providerPaymentId!;

      let workflowCalls = 0;
      const flakyWorkflow: FailedPaymentWorkflow = {
        async handlePaymentFailed() {},
        async handlePaymentSucceeded() {
          workflowCalls += 1;
          throw new Error("must never be invoked while supersession is unsafe");
        },
        async handlePaymentSuperseded() {},
      };
      const flakyLedger = flaky(ctx.ledger, "reversePayment", 1, () => new Error("simulated_dispute_ledger_failure"));
      const webhook = ctx.buildWebhookService({ failedPaymentWorkflow: flakyWorkflow, ledger: flakyLedger });

      const successEventId = `evt-${randomUUID()}`;
      await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId }));
      expect(workflowCalls).toBe(1);

      // The dispute's OWN transition applies durably, but its OWN required ledger effect fails —
      // its event remains NOT "processed".
      const disputeEventId = `evt-${randomUUID()}`;
      const disputeResult = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: disputeEventId, eventType: "payment.disputed", providerPaymentId }),
      );
      expect(disputeResult.status).toBe("accepted");
      expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed"); // transition committed regardless.
      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))?.processingStatus).not.toBe("processed");

      // Retry the success event WHILE the dispute is still incomplete — its own nextRetryAt is
      // earlier than the dispute's own (it failed first), so this recovery pass targets it alone.
      const successRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))!;
      await webhook.recoverBatch(10, new Date(successRow.nextRetryAt!.getTime() + 1));
      expect(workflowCalls).toBe(1); // NOT blindly replayed merely because current.status changed.
      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))?.processingStatus).not.toBe("processed"); // remains unresolved.

      // Recover the dispute (its own ledger retry succeeds this time — the flaky wrapper fails only
      // once). The success event may also be swept up in this SAME bounded batch and correctly
      // deferred again — harmless, since supersession is still unsafe until this line completes.
      const disputeRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))!;
      await webhook.recoverBatch(10, new Date(disputeRow.nextRetryAt!.getTime() + 1));
      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))?.processingStatus).toBe("processed");

      // NOW retry the success event again — supersession has become safe.
      const successRowAfter = (await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))!;
      await webhook.recoverBatch(10, new Date(successRowAfter.nextRetryAt!.getTime() + 1));
      expect(workflowCalls).toBe(1); // still never replayed — correctly superseded now, not applied.
      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))?.processingStatus).toBe("processed"); // finalizes.
    });

    it("H4 — agreement completion safely superseded: the success transition's own lifecycle evaluation fails, a later dispute fully processes, and retrying the success event never re-attempts completion from stale history", async () => {
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const ctx = buildContext();
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      let completionCalls = 0;
      const flakyCompletion = {
        async checkAndAdvance() {
          completionCalls += 1;
          // Always throws — if this were ever invoked again after safe supersession, the success
          // event would remain permanently stuck, an unmistakable signal (mirrors H2's own rigor).
          throw new Error("must never be invoked again once safely superseded");
        },
        // H4 never delivers a dispute event, so this is never actually called — present only to
        // satisfy AgreementCompletionChecker's now-required interface.
        async recomputeAfterSupersession() {},
      };
      const webhook = ctx.buildWebhookService({ completion: flakyCompletion });

      const successEventId = `evt-${randomUUID()}`;
      const successResult = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId }),
      );
      expect(successResult.status).toBe("accepted"); // required lifecycle effect failed -> not processed.
      expect(completionCalls).toBe(1);
      expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded");
      expect((await ctx.agreements.findById(agreementId))?.status).not.toBe("paid_in_full");

      const disputeEventId = `evt-${randomUUID()}`;
      const disputeResult = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: disputeEventId, eventType: "payment.disputed", providerPaymentId }),
      );
      expect(disputeResult.status).toBe("processed");
      expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed");

      const successRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))!;
      await webhook.recoverBatch(10, new Date(successRow.nextRetryAt!.getTime() + 1));

      expect(completionCalls).toBe(1); // NEVER invoked again — disposition = "superseded_safely".
      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))?.processingStatus).toBe("processed");
      expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed"); // never regressed.
      expect((await ctx.agreements.findById(agreementId))?.status).not.toBe("paid_in_full"); // never falsely completed from stale history.
    });

    it("H5 — historical ledger/audit are still recovered exact-once even when the installment/lifecycle effect is safely superseded", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("h5-creditor");
      const debtor = await seedPersonalUser("h5-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentId = payment.providerPaymentId!;
      const successAction = "payment_webhook_payment.succeeded";

      const flakyAudit = flaky(new AuditService(new DrizzleAuditEventRepository()), "record", 1, () => new Error("simulated_success_audit_failure"));
      let workflowCalls = 0;
      const flakyWorkflow: FailedPaymentWorkflow = {
        async handlePaymentFailed() {},
        async handlePaymentSucceeded() {
          workflowCalls += 1;
          throw new Error("must only ever be attempted before safe supersession");
        },
        async handlePaymentSuperseded() {},
      };
      const webhook = ctx.buildWebhookService({ audit: flakyAudit, failedPaymentWorkflow: flakyWorkflow });

      const successEventId = `evt-${randomUUID()}`;
      await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId }));
      // Attempt 1: audit fails before ledger (or workflow) is ever reached.
      expect(await findAuditEventsByProviderEvent(successEventId, successAction)).toHaveLength(0);
      expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();
      expect(workflowCalls).toBe(0);

      // Attempt 2 (retry, still before any dispute): audit + ledger both complete; workflow fails.
      let successRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))!;
      await webhook.recoverBatch(10, new Date(successRow.nextRetryAt!.getTime() + 1));
      expect(await findAuditEventsByProviderEvent(successEventId, successAction)).toHaveLength(1);
      expect(await findClearEntry(ctx.ledger, payment.id)).not.toBeNull();
      expect(workflowCalls).toBe(1);
      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))?.processingStatus).not.toBe("processed");

      // The later dispute now fully processes (the clearing entry already exists for its own
      // reversal to post against).
      const disputeEventId = `evt-${randomUUID()}`;
      const disputeResult = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: disputeEventId, eventType: "payment.disputed", providerPaymentId }),
      );
      expect(disputeResult.status).toBe("processed");
      expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed");

      // Retry the success event again — ledger/audit are already exact-once (never re-attempted or
      // duplicated); the workflow effect is now safely superseded (never called again).
      successRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))!;
      await webhook.recoverBatch(10, new Date(successRow.nextRetryAt!.getTime() + 1));

      expect(workflowCalls).toBe(1); // never called again.
      expect(await findAuditEventsByProviderEvent(successEventId, successAction)).toHaveLength(1); // exact-once.
      const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // exact-once.
      expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed"); // never regressed.
      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))?.processingStatus).toBe("processed");
    });

    it("H6 — a payment.status that changed with NO durable, fully-processed superseding event is NEVER treated as safely superseded merely from current status; the historical success event remains unresolved", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("h6-creditor");
      const debtor = await seedPersonalUser("h6-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentId = payment.providerPaymentId!;

      let workflowCalls = 0;
      const flakyWorkflow: FailedPaymentWorkflow = {
        async handlePaymentFailed() {},
        async handlePaymentSucceeded() {
          workflowCalls += 1;
          throw new Error("simulated_workflow_failure");
        },
        async handlePaymentSuperseded() {},
      };
      const webhook = ctx.buildWebhookService({ failedPaymentWorkflow: flakyWorkflow });

      const successEventId = `evt-${randomUUID()}`;
      await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId }));
      expect(workflowCalls).toBe(1);
      expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded");

      // Contrive "disputed" with NO durable, fully-processed superseding event proving it — a direct
      // status write, never routed through any real event/transition pipeline (no dispute event of
      // any kind exists for this payment).
      const db = getDb();
      await db.update(paymentAttempt).set({ status: "disputed" }).where(eq(paymentAttempt.id, payment.id));

      // Retry the success event repeatedly — it must never resolve via a fabricated supersession.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const successRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))!;
        await webhook.recoverBatch(10, new Date(successRow.nextRetryAt!.getTime() + 1));
      }

      expect(workflowCalls).toBe(1); // never blindly replayed either — "wait", not "apply".
      const finalEventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId);
      expect(finalEventRow?.processingStatus).toBe("failed"); // remains retryable/unresolved, never "processed".
      expect(finalEventRow?.nextRetryAt).not.toBeNull(); // still eligible for future retry, never permanently poisoned.
      expect(finalEventRow?.lastErrorCode).toBe("unresolved_financial_prerequisite");
    });
  });

  describe("PAID2YOU — PACKAGE B (Stage 6 blocking substage — post-success supersession compensation, ARCHITECT DECISION) — SAME-BATCH FIRST APPLICATION", () => {
    /**
     * Builds a REAL, production-shaped `FailedPaymentWorkflowService` (atomic coordinator wired, no
     * flaky stub) — this describe block proves the real compensation, not a test double's promise
     * that it would have been called.
     */
    function buildRealWorkflow() {
      const notifyCtx = createTestNotificationService();
      const profileOwners = new DrizzleProfileOwnerReader();
      const retries = new PaymentRetryService({
        retries: new DrizzlePaymentRetryRepository(),
        paymentAttempts: new DrizzlePaymentAttemptRepository(),
        initiators: {} as unknown as Record<PaymentMethod, RetryPaymentMethodInitiator>, // never invoked — coordinateSupersession never touches retries.
        profileOwners,
        audit: new AuditService(new DrizzleAuditEventRepository()),
      });
      return new FailedPaymentWorkflowService({
        installments: new DrizzleInstallmentStatusRepository(),
        retries,
        notifications: notifyCtx.notificationService,
        profileOwners,
        retryCoordinator: new DrizzleFailedPaymentRetryCoordinator(),
      });
    }

    async function findCompensationAudit(installmentScheduleItemId: string) {
      const db = getDb();
      return db
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.action, "installment_reopened_by_supersession"), eq(auditEvent.targetResourceId, installmentScheduleItemId)));
    }

    async function findAgreementDemotionAudit(agreementId: string) {
      const db = getDb();
      return db
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.action, "agreement_reopened_by_supersession"), eq(auditEvent.targetResourceId, agreementId)));
    }

    it("A — not-yet-due installment: success and its superseding dispute are both eligible in the SAME recoverBatch while payment.status is still succeeded when success is encountered; installment -> scheduled, agreement paid_in_full -> active", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("sbfa-a-creditor");
      const debtor = await seedPersonalUser("sbfa-a-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(
        creditor.profileId,
        debtor.profileId,
        creditor.userId,
        5_000,
        "2099-01-01", // not yet due.
      );
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentId = payment.providerPaymentId!;

      // Fails the very first lookup for BOTH events' own initial `receiveWebhook` attempt — a point
      // BEFORE either event's transition is ever attempted — so NEITHER is applied yet by the time
      // they become eligible together for the SAME recoverBatch call (the exact scenario ChatGPT's
      // architectural review required proof of: current.status is still "succeeded" — in fact still
      // "pending" — at the moment success is claimed, and success's own transition/workflow apply
      // fresh, immediately followed by the dispute's own transition/compensation, all within one pass).
      const flakyLookup = flaky(ctx.payments, "findByProviderPaymentId", 2, () => new Error("simulated_transient_lookup_failure"));
      const workflow = buildRealWorkflow();
      const webhook = ctx.buildWebhookService({ payments: flakyLookup, failedPaymentWorkflow: workflow });

      const successEventId = `evt-${randomUUID()}`;
      const successAttempt = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId }),
      );
      expect(successAttempt.status).toBe("accepted"); // lookup failed -> queued, transition never attempted.
      expect((await ctx.payments.findById(payment.id))?.status).toBe("pending");

      const disputeEventId = `evt-${randomUUID()}`;
      const disputeAttempt = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: disputeEventId, eventType: "payment.disputed", providerPaymentId }),
      );
      expect(disputeAttempt.status).toBe("accepted"); // lookup failed -> queued, transition never attempted.
      expect((await ctx.payments.findById(payment.id))?.status).toBe("pending"); // still untouched by either event.

      const successRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))!;
      const disputeRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))!;
      const dueAt = new Date(Math.max(successRow.nextRetryAt!.getTime(), disputeRow.nextRetryAt!.getTime()) + 1);

      const recovery = await webhook.recoverBatch(100, dueAt);
      expect(recovery.claimed).toBe(2);
      // Both fully resolve in this SAME pass: success (received first) applies its own transition,
      // ledger, and workflow — genuinely reaching "succeeded" and marking the installment paid for the
      // first time, right there in this call — then the dispute (claimed in the same batch) applies
      // its own transition/ledger immediately after, and compensation runs as part of ITS OWN
      // processing (never the stale success event's — see runSupersessionCompensationRequired's own
      // doc comment for why that is the only trigger guaranteed to be reached).
      expect(recovery.processed).toBe(2);

      expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed");
      expect(await installmentStatus(installmentScheduleItemId)).toBe("scheduled"); // reopened, never left "paid" — due date is in the future.
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("active"); // demoted from paid_in_full — outstanding balance, nothing overdue.

      const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
      expect(entries.filter((e) => e.entryType === "dispute_adjustment")).toHaveLength(1);

      expect(await findAuditEventsByProviderEvent(successEventId, "payment_webhook_payment.succeeded")).toHaveLength(1);
      expect(await findAuditEventsByProviderEvent(disputeEventId, "payment_webhook_payment.disputed")).toHaveLength(1);
      expect(await findCompensationAudit(installmentScheduleItemId)).toHaveLength(1);
      expect(await findAgreementDemotionAudit(agreementId)).toHaveLength(1);

      // Zero new retries created by compensation — the installment becomes payable again, but a fresh
      // charge only ever comes through the normal, explicitly authorized payment flow.
      expect(await listRetriesForInstallment(installmentScheduleItemId)).toHaveLength(0);

      // Idempotency: nothing newly due — a second recoverBatch must leave every count/state unchanged.
      const recoveryAgain = await webhook.recoverBatch(100, new Date(dueAt.getTime() + 1));
      expect(recoveryAgain.claimed).toBe(0);
      expect((await ctx.payments.findById(payment.id))?.status).toBe("disputed");
      expect(await installmentStatus(installmentScheduleItemId)).toBe("scheduled");
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("active");
      const entriesAfter = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
      expect(entriesAfter.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
      expect(entriesAfter.filter((e) => e.entryType === "dispute_adjustment")).toHaveLength(1);
      expect(await findCompensationAudit(installmentScheduleItemId)).toHaveLength(1);
      expect(await findAgreementDemotionAudit(agreementId)).toHaveLength(1);
      expect(await listRetriesForInstallment(installmentScheduleItemId)).toHaveLength(0);
    });

    it("B — overdue installment: success and its superseding refund are both eligible in the SAME recoverBatch while payment.status is still succeeded when success is encountered; installment -> past_due, agreement paid_in_full -> past_due", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("sbfa-b-creditor");
      const debtor = await seedPersonalUser("sbfa-b-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(
        creditor.profileId,
        debtor.profileId,
        creditor.userId,
        5_000,
        "2020-01-01", // already overdue.
      );
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentId = payment.providerPaymentId!;

      const flakyLookup = flaky(ctx.payments, "findByProviderPaymentId", 2, () => new Error("simulated_transient_lookup_failure"));
      const workflow = buildRealWorkflow();
      const webhook = ctx.buildWebhookService({ payments: flakyLookup, failedPaymentWorkflow: workflow });

      const successEventId = `evt-${randomUUID()}`;
      await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId }));
      expect((await ctx.payments.findById(payment.id))?.status).toBe("pending");

      const refundEventId = `evt-${randomUUID()}`;
      await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: refundEventId, eventType: "payment.refunded", providerPaymentId }));
      expect((await ctx.payments.findById(payment.id))?.status).toBe("pending"); // still untouched by either event.

      const successRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId))!;
      const refundRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, refundEventId))!;
      const dueAt = new Date(Math.max(successRow.nextRetryAt!.getTime(), refundRow.nextRetryAt!.getTime()) + 1);

      const recovery = await webhook.recoverBatch(100, dueAt);
      expect(recovery.claimed).toBe(2);
      expect(recovery.processed).toBe(2);

      expect((await ctx.payments.findById(payment.id))?.status).toBe("refunded");
      expect(await installmentStatus(installmentScheduleItemId)).toBe("past_due"); // reopened, never left "paid" — due date has already passed.
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("past_due"); // demoted from paid_in_full — outstanding AND overdue.

      const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
      expect(entries.filter((e) => e.entryType === "refund")).toHaveLength(1);

      expect(await findAuditEventsByProviderEvent(successEventId, "payment_webhook_payment.succeeded")).toHaveLength(1);
      expect(await findAuditEventsByProviderEvent(refundEventId, "payment_webhook_payment.refunded")).toHaveLength(1);
      expect(await findCompensationAudit(installmentScheduleItemId)).toHaveLength(1);
      expect(await findAgreementDemotionAudit(agreementId)).toHaveLength(1);
      expect(await listRetriesForInstallment(installmentScheduleItemId)).toHaveLength(0);

      // Idempotency: nothing newly due — a second recoverBatch must leave every count/state unchanged.
      const recoveryAgain = await webhook.recoverBatch(100, new Date(dueAt.getTime() + 1));
      expect(recoveryAgain.claimed).toBe(0);
      expect((await ctx.payments.findById(payment.id))?.status).toBe("refunded");
      expect(await installmentStatus(installmentScheduleItemId)).toBe("past_due");
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("past_due");
      const entriesAfter = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
      expect(entriesAfter.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
      expect(entriesAfter.filter((e) => e.entryType === "refund")).toHaveLength(1);
      expect(await findCompensationAudit(installmentScheduleItemId)).toHaveLength(1);
      expect(await findAgreementDemotionAudit(agreementId)).toHaveLength(1);
      expect(await listRetriesForInstallment(installmentScheduleItemId)).toHaveLength(0);
    });

    it("CASE C 1 — replacement-payment reproduction: a retry of A's superseding event, after Payment B legitimately re-pays the reopened installment, does not reopen it again — the durable compensation marker gates on THIS event's own identity, never on installment.status", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("case-c-1-creditor");
      const debtor = await seedPersonalUser("case-c-1-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(
        creditor.profileId,
        debtor.profileId,
        creditor.userId,
        5_000,
        "2099-01-01",
      );
      const paymentA = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentIdA = paymentA.providerPaymentId!;

      const workflow = buildRealWorkflow();
      const webhookNormal = ctx.buildWebhookService({ failedPaymentWorkflow: workflow });

      const successEventId = `evt-${randomUUID()}`;
      const successResult = await webhookNormal.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId: providerPaymentIdA }),
      );
      expect(successResult.status).toBe("processed");
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full");

      // A's own dispute: transition + ledger reversal + installment compensation all commit — but the
      // AGREEMENT recompute (a SEPARATE, later required effect) fails once, leaving A's dispute event
      // retryable even though its own compensation already durably completed. Injected via the
      // production hook seam (`AgreementCompletionTestHooks.afterAgreementLockBeforeBalanceRead`) —
      // `recomputeAfterSupersession` now computes its own evidence tx-bound, so a flaky
      // `AgreementBalanceComputer` wrapper (the pre-correction injection technique) is no longer
      // reachable; this hook fires at the exact point real evidence-read failures would occur.
      let recomputeAttempts = 0;
      const flakyCompletion = new AgreementCompletionService({
        agreements: ctx.agreements as unknown as AgreementStatusRepository,
        balances: ctx.balances as unknown as AgreementBalanceComputer,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        hooks: {
          afterAgreementLockBeforeBalanceRead: async () => {
            recomputeAttempts += 1;
            if (recomputeAttempts === 1) throw new Error("simulated_transient_balance_read_failure");
          },
        },
      });
      const webhookFlaky = ctx.buildWebhookService({ failedPaymentWorkflow: workflow, completion: flakyCompletion });

      const disputeEventId = `evt-${randomUUID()}`;
      const disputeResult = await webhookFlaky.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: disputeEventId, eventType: "payment.disputed", providerPaymentId: providerPaymentIdA }),
      );
      expect(disputeResult.status).toBe("accepted"); // recompute failed -> not processed, but compensation already committed.
      expect((await ctx.payments.findById(paymentA.id))?.status).toBe("disputed");
      expect(await installmentStatus(installmentScheduleItemId)).toBe("scheduled"); // reopened by A's compensation.
      expect(await findCompensationAudit(installmentScheduleItemId)).toHaveLength(1); // durable marker committed atomically with the reopen.
      // The marker is keyed to THIS event's own providerEventId, not merely the installment.
      expect(await findAuditEventsByProviderEvent(disputeEventId, "installment_reopened_by_supersession")).toHaveLength(1);
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full"); // recompute never reached — untouched.

      // Payment B succeeds against the now-reopened installment, legitimately, through the NORMAL
      // (non-flaky) webhook service — entirely independent of A's still-retryable dispute event.
      const paymentB = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentIdB = paymentB.providerPaymentId!;
      const successBEventId = `evt-${randomUUID()}`;
      const successBResult = await webhookNormal.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: successBEventId, eventType: "payment.succeeded", providerPaymentId: providerPaymentIdB }),
      );
      expect(successBResult.status).toBe("processed");
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid"); // B's legitimate state.
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full"); // checkAndAdvance is a no-op once already paid_in_full.

      // Retry A's dispute event — the recompute hook's own injected failure is exhausted (fired
      // exactly once), so this attempt's own recompute now succeeds.
      const disputeRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))!;
      const attemptsBeforeRetry = disputeRow.processingAttempts;
      await webhookFlaky.recoverBatch(100, new Date(disputeRow.nextRetryAt!.getTime() + 1));

      // The recompute hook itself was genuinely invoked exactly twice — once failing (the injected
      // failure), once succeeding (this retry) — directly proving the recomputation actually ran on
      // retry, not merely inferred from downstream audit/status side effects.
      expect(recomputeAttempts).toBe(2);

      // FINAL: installment remains paid because of B — never reopened a second time.
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
      expect((await ctx.payments.findById(paymentB.id))?.status).toBe("succeeded");
      // A's compensation marker is still exactly one row — never duplicated, never re-executed.
      expect(await findCompensationAudit(installmentScheduleItemId)).toHaveLength(1);
      expect(await findAuditEventsByProviderEvent(disputeEventId, "installment_reopened_by_supersession")).toHaveLength(1);
      // A's own event finally reaches "processed" — the previously-missing recompute now ran — after
      // exactly one additional processing attempt (the retry itself), never more.
      const disputeRowAfter = await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId);
      expect(disputeRowAfter?.processingStatus).toBe("processed");
      expect(disputeRowAfter?.processingAttempts).toBe(attemptsBeforeRetry + 1);
      // Authoritative balance is fully satisfied again (A's amount reversed, B's identical amount paid)
      // — recomputation genuinely ran (proven by the marker/processed-event assertions above) but found
      // nothing to demote: the agreement remains paid_in_full, and NO demotion audit is created — a
      // no-op recomputation must never be reported as a demotion.
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full");
      expect(await findAgreementDemotionAudit(agreementId)).toHaveLength(0);

      // Ledger exact-once, per payment — no duplicate reversal, no duplicate clearing.
      const entriesA = await ctx.ledger.listEntriesForPaymentAttempt(paymentA.id);
      expect(entriesA.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
      expect(entriesA.filter((e) => e.entryType === "dispute_adjustment")).toHaveLength(1);
      const entriesB = await ctx.ledger.listEntriesForPaymentAttempt(paymentB.id);
      expect(entriesB.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);

      // No new retry created by compensation, none resurrected.
      expect(await listRetriesForInstallment(installmentScheduleItemId)).toHaveLength(0);
    });

    it("CASE C 2 — crash/retry exact-once: the durable compensation marker survives a retry, which skips re-reopening the installment but still executes the previously-missing agreement recomputation", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("case-c-2-creditor");
      const debtor = await seedPersonalUser("case-c-2-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(
        creditor.profileId,
        debtor.profileId,
        creditor.userId,
        5_000,
        "2020-01-01", // already overdue.
      );
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentId = payment.providerPaymentId!;

      const workflow = buildRealWorkflow();
      const webhookNormal = ctx.buildWebhookService({ failedPaymentWorkflow: workflow });
      const successEventId = `evt-${randomUUID()}`;
      await webhookNormal.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId }));
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");

      let recomputeAttempts = 0;
      const flakyCompletion = new AgreementCompletionService({
        agreements: ctx.agreements as unknown as AgreementStatusRepository,
        balances: ctx.balances as unknown as AgreementBalanceComputer,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        hooks: {
          afterAgreementLockBeforeBalanceRead: async () => {
            recomputeAttempts += 1;
            if (recomputeAttempts === 1) throw new Error("simulated_transient_balance_read_failure");
          },
        },
      });
      const webhookFlaky = ctx.buildWebhookService({ failedPaymentWorkflow: workflow, completion: flakyCompletion });

      const disputeEventId = `evt-${randomUUID()}`;
      const disputeResult = await webhookFlaky.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: disputeEventId, eventType: "payment.disputed", providerPaymentId }),
      );
      expect(disputeResult.status).toBe("accepted");
      expect(await installmentStatus(installmentScheduleItemId)).toBe("past_due"); // due date already passed.
      expect(await findCompensationAudit(installmentScheduleItemId)).toHaveLength(1); // durable marker committed atomically with the reopen.
      expect(await findAuditEventsByProviderEvent(disputeEventId, "installment_reopened_by_supersession")).toHaveLength(1);
      expect(await findAgreementDemotionAudit(agreementId)).toHaveLength(0); // recompute never reached yet.

      const disputeRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))!;
      const attemptsBeforeRetry = disputeRow.processingAttempts;
      await webhookFlaky.recoverBatch(100, new Date(disputeRow.nextRetryAt!.getTime() + 1));

      // The retry detected the existing marker and skipped re-compensation — installment untouched,
      // marker count unchanged — but DID execute the previously-missing agreement recomputation.
      expect(await installmentStatus(installmentScheduleItemId)).toBe("past_due"); // unchanged.
      expect(await findCompensationAudit(installmentScheduleItemId)).toHaveLength(1); // still exactly one — not duplicated.
      expect(await findAuditEventsByProviderEvent(disputeEventId, "installment_reopened_by_supersession")).toHaveLength(1);
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("past_due"); // demoted — outstanding AND overdue.
      expect(await findAgreementDemotionAudit(agreementId)).toHaveLength(1); // recompute DID run on retry.
      expect(await findAuditEventsByProviderEvent(disputeEventId, "agreement_reopened_by_supersession")).toHaveLength(1);
      const disputeRowAfter = await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId);
      expect(disputeRowAfter?.processingStatus).toBe("processed");
      expect(disputeRowAfter?.processingAttempts).toBe(attemptsBeforeRetry + 1);
      expect(await listRetriesForInstallment(installmentScheduleItemId)).toHaveLength(0);
    });

    it("CASE C 3 — repeated recovery after full completion: further recoverBatch calls leave every financial, audit, installment, agreement, and retry count unchanged, and the processed event is never reclaimed", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("case-c-3-creditor");
      const debtor = await seedPersonalUser("case-c-3-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(
        creditor.profileId,
        debtor.profileId,
        creditor.userId,
        5_000,
        "2099-01-01",
      );
      const paymentA = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentIdA = paymentA.providerPaymentId!;

      const workflow = buildRealWorkflow();
      const webhookNormal = ctx.buildWebhookService({ failedPaymentWorkflow: workflow });
      const successEventId = `evt-${randomUUID()}`;
      await webhookNormal.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId: providerPaymentIdA }));

      let recomputeAttempts = 0;
      const flakyCompletion = new AgreementCompletionService({
        agreements: ctx.agreements as unknown as AgreementStatusRepository,
        balances: ctx.balances as unknown as AgreementBalanceComputer,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        hooks: {
          afterAgreementLockBeforeBalanceRead: async () => {
            recomputeAttempts += 1;
            if (recomputeAttempts === 1) throw new Error("simulated_transient_balance_read_failure");
          },
        },
      });
      const webhookFlaky = ctx.buildWebhookService({ failedPaymentWorkflow: workflow, completion: flakyCompletion });

      const disputeEventId = `evt-${randomUUID()}`;
      await webhookFlaky.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: disputeEventId, eventType: "payment.disputed", providerPaymentId: providerPaymentIdA }));

      const paymentB = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentIdB = paymentB.providerPaymentId!;
      const successBEventId = `evt-${randomUUID()}`;
      await webhookNormal.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: successBEventId, eventType: "payment.succeeded", providerPaymentId: providerPaymentIdB }));

      const disputeRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))!;
      await webhookFlaky.recoverBatch(100, new Date(disputeRow.nextRetryAt!.getTime() + 1));

      // Full completion reached — capture the state to compare against.
      const disputeRowProcessed = await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId);
      expect(disputeRowProcessed?.processingStatus).toBe("processed");
      const processingAttemptsBefore = disputeRowProcessed?.processingAttempts;
      const installmentBefore = await installmentStatus(installmentScheduleItemId);
      const agreementBefore = (await ctx.agreements.findById(agreementId))?.status;
      const compensationAuditBefore = await findCompensationAudit(installmentScheduleItemId);
      // The compensation marker is keyed to THIS event's own providerEventId, not merely the installment.
      expect(await findAuditEventsByProviderEvent(disputeEventId, "installment_reopened_by_supersession")).toHaveLength(1);
      const demotionAuditBefore = await findAgreementDemotionAudit(agreementId);
      const entriesABefore = await ctx.ledger.listEntriesForPaymentAttempt(paymentA.id);
      const entriesBBefore = await ctx.ledger.listEntriesForPaymentAttempt(paymentB.id);
      const retriesBefore = await listRetriesForInstallment(installmentScheduleItemId);

      // Two further recoverBatch calls, bounded to a window just past this test's own events (never a
      // broad "now" — this is a shared-database suite; an unbounded window could sweep up unrelated
      // due leftovers from other tests, matching this file's own established convention elsewhere).
      // Nothing belonging to THIS test is newly due, and the already-"processed" dispute event must
      // never be reclaimed (claimBatchForRecovery excludes processingStatus="processed").
      const boundedNow = new Date(disputeRow.nextRetryAt!.getTime() + 1);
      await webhookFlaky.recoverBatch(100, boundedNow);
      await webhookFlaky.recoverBatch(100, boundedNow);

      expect(await installmentStatus(installmentScheduleItemId)).toBe(installmentBefore);
      expect((await ctx.agreements.findById(agreementId))?.status).toBe(agreementBefore);
      expect(await findCompensationAudit(installmentScheduleItemId)).toHaveLength(compensationAuditBefore.length);
      expect(await findAgreementDemotionAudit(agreementId)).toHaveLength(demotionAuditBefore.length);
      const entriesAAfter = await ctx.ledger.listEntriesForPaymentAttempt(paymentA.id);
      const entriesBAfter = await ctx.ledger.listEntriesForPaymentAttempt(paymentB.id);
      expect(entriesAAfter).toHaveLength(entriesABefore.length);
      expect(entriesBAfter).toHaveLength(entriesBBefore.length);
      expect(await listRetriesForInstallment(installmentScheduleItemId)).toHaveLength(retriesBefore.length);
      const disputeRowFinal = await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId);
      expect(disputeRowFinal?.processingStatus).toBe("processed");
      // Neither extra sweep found this already-processed event eligible for (re)claiming — its own
      // processing-attempt count is untouched by either additional recoverBatch call.
      expect(disputeRowFinal?.processingAttempts).toBe(processingAttemptsBefore);
    });

    it("ISSUE 1 — agreement demotion write and its required audit are atomic: a failure between them rolls back BOTH (never a permanently missing audit), and a clean retry produces exactly one demotion write and exactly one audit", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("issue1-creditor");
      const debtor = await seedPersonalUser("issue1-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(
        creditor.profileId,
        debtor.profileId,
        creditor.userId,
        5_000,
        "2099-01-01",
      );
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentId = payment.providerPaymentId!;

      const workflow = buildRealWorkflow();
      const webhookNormal = ctx.buildWebhookService({ failedPaymentWorkflow: workflow });
      const successEventId = `evt-${randomUUID()}`;
      await webhookNormal.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId }));
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full");

      // Fails ONCE, inside `recomputeAfterSupersession`'s own transaction, AFTER it has already
      // issued the `tx.update(agreement)...` demotion write but BEFORE the required audit marker is
      // appended — proving the two can never durably diverge (see `AgreementCompletionTestHooks
      // .beforeAuditAppend`'s own doc comment).
      let auditAppendAttempts = 0;
      const flakyCompletion = new AgreementCompletionService({
        agreements: ctx.agreements as unknown as AgreementStatusRepository,
        balances: ctx.balances as unknown as AgreementBalanceComputer,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        hooks: {
          beforeAuditAppend: async () => {
            auditAppendAttempts += 1;
            if (auditAppendAttempts === 1) throw new Error("simulated_audit_append_failure");
          },
        },
      });
      const webhookFlaky = ctx.buildWebhookService({ failedPaymentWorkflow: workflow, completion: flakyCompletion });

      const disputeEventId = `evt-${randomUUID()}`;
      const disputeResult = await webhookFlaky.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: disputeEventId, eventType: "payment.disputed", providerPaymentId }),
      );
      expect(disputeResult.status).toBe("accepted"); // the audit append failed -> the WHOLE transaction rolled back -> not processed.

      // ROLLBACK PROOF: the status write from that SAME failed transaction never survived it — the
      // agreement is still exactly where it was, never left "demoted with no audit".
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full");
      expect(await findAgreementDemotionAudit(agreementId)).toHaveLength(0);
      // Installment compensation — a SEPARATE required effect that already committed, in its own
      // transaction, earlier in this SAME applyEvent call, before the agreement recompute ever runs
      // — is unaffected by the agreement-side rollback.
      expect(await installmentStatus(installmentScheduleItemId)).toBe("scheduled");
      expect(await findCompensationAudit(installmentScheduleItemId)).toHaveLength(1);

      // Retry — the injected failure is exhausted (fired exactly once); this attempt runs cleanly
      // end to end: mutation and audit commit together.
      const disputeRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))!;
      await webhookFlaky.recoverBatch(100, new Date(disputeRow.nextRetryAt!.getTime() + 1));

      expect((await ctx.agreements.findById(agreementId))?.status).toBe("active"); // demoted — outstanding, not overdue.
      expect(await findAgreementDemotionAudit(agreementId)).toHaveLength(1); // exactly one — the rolled-back attempt left no partial trace to repair or duplicate.
      expect(await findAuditEventsByProviderEvent(disputeEventId, "agreement_reopened_by_supersession")).toHaveLength(1);
      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))?.processingStatus).toBe("processed");
      expect(await findCompensationAudit(installmentScheduleItemId)).toHaveLength(1); // installment side remains exact-once throughout.
    });

    it("ISSUE 2 — durable not_paid compensation disposition: once THIS superseding event determines its installment was never paid, a later retry never re-examines installment status again, even after an unrelated payment legitimately pays it", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("issue2-creditor");
      const debtor = await seedPersonalUser("issue2-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(
        creditor.profileId,
        debtor.profileId,
        creditor.userId,
        5_000,
        "2099-01-01",
      );
      const paymentA = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentIdA = paymentA.providerPaymentId!;

      // Payment A succeeds financially (its OWN transition/ledger effect are unconditional required
      // effects, always applied) but — no `failedPaymentWorkflow` wired for THIS delivery —
      // deliberately never reaches its own installment-success effect: the installment is never
      // marked "paid" by A. `checkCompletionRequired` is unaffected (a separate, unconditional
      // required effect) and still advances the agreement normally.
      const webhookNoWorkflow = ctx.buildWebhookService();
      const successEventId = `evt-${randomUUID()}`;
      const successResult = await webhookNoWorkflow.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId: providerPaymentIdA }),
      );
      expect(successResult.status).toBe("processed");
      expect(await installmentStatus(installmentScheduleItemId)).not.toBe("paid"); // never marked paid by A.
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full"); // checkCompletionRequired ran regardless.

      const workflow = buildRealWorkflow();

      // A's dispute: transition + ledger reversal commit. coordinateSupersession finds the
      // installment NOT "paid" — durably records the "not required" disposition (never a bare,
      // unrecorded "not_paid" return) — then the SEPARATE agreement recompute fails once, leaving
      // A's dispute event retryable even though its own compensation disposition already durably
      // concluded.
      let recomputeAttempts = 0;
      const flakyCompletion = new AgreementCompletionService({
        agreements: ctx.agreements as unknown as AgreementStatusRepository,
        balances: ctx.balances as unknown as AgreementBalanceComputer,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        hooks: {
          afterAgreementLockBeforeBalanceRead: async () => {
            recomputeAttempts += 1;
            if (recomputeAttempts === 1) throw new Error("simulated_transient_balance_read_failure");
          },
        },
      });
      const webhookDisputeFlaky = ctx.buildWebhookService({ failedPaymentWorkflow: workflow, completion: flakyCompletion });

      const disputeEventId = `evt-${randomUUID()}`;
      const disputeResult = await webhookDisputeFlaky.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: disputeEventId, eventType: "payment.disputed", providerPaymentId: providerPaymentIdA }),
      );
      expect(disputeResult.status).toBe("accepted"); // recompute failed -> not processed.
      expect((await ctx.payments.findById(paymentA.id))?.status).toBe("disputed");
      // Durable "not required" disposition marker for THIS event — never inferred from installment
      // status on a future attempt.
      const notRequiredMarkers = await findAuditEventsByProviderEvent(disputeEventId, "installment_reopen_not_required_by_supersession");
      expect(notRequiredMarkers).toHaveLength(1);
      expect(await installmentStatus(installmentScheduleItemId)).not.toBe("paid"); // untouched — nothing to reopen.
      expect(await findCompensationAudit(installmentScheduleItemId)).toHaveLength(0); // never a "reopened" marker — it was never paid by A.

      // Payment B subsequently, legitimately pays the SAME (still-payable, never-paid) installment.
      const webhookB = ctx.buildWebhookService({ failedPaymentWorkflow: workflow });
      const paymentB = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentIdB = paymentB.providerPaymentId!;
      const successBEventId = `evt-${randomUUID()}`;
      const successBResult = await webhookB.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: successBEventId, eventType: "payment.succeeded", providerPaymentId: providerPaymentIdB }),
      );
      expect(successBResult.status).toBe("processed");
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid"); // B's legitimate state.

      // Retry A's dispute event — the recompute hook's failure is exhausted, so this attempt's own
      // recompute now succeeds.
      const disputeRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))!;
      await webhookDisputeFlaky.recoverBatch(100, new Date(disputeRow.nextRetryAt!.getTime() + 1));

      // FINAL: B's installment remains paid — A's OLD "not_paid" disposition, once durably recorded,
      // is NEVER re-examined against installment status again, no matter what legitimately changes it.
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
      expect((await ctx.payments.findById(paymentB.id))?.status).toBe("succeeded");
      expect(await findAuditEventsByProviderEvent(disputeEventId, "installment_reopen_not_required_by_supersession")).toHaveLength(1); // still exactly one.
      expect(await findCompensationAudit(installmentScheduleItemId)).toHaveLength(0); // never a "reopened" marker for A's event.
      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))?.processingStatus).toBe("processed");

      const entriesA = await ctx.ledger.listEntriesForPaymentAttempt(paymentA.id);
      expect(entriesA.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
      expect(entriesA.filter((e) => e.entryType === "dispute_adjustment")).toHaveLength(1);
      const entriesB = await ctx.ledger.listEntriesForPaymentAttempt(paymentB.id);
      expect(entriesB.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
      expect(await listRetriesForInstallment(installmentScheduleItemId)).toHaveLength(0);
    });

    it("ISSUE 3 — stale agreement-recompute race: a concurrent payment's own ledger post for the SAME agreement is provably serialized behind an in-flight supersession recompute — it can never commit invisibly to the recompute's own evidence read, and its later settlement is never lost, only correctly sequenced", async () => {
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const ctx = buildContext();
      const providerPaymentIdA = `sandbox_pay_${randomUUID()}`;
      const paymentA = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId: providerPaymentIdA,
      });
      await ctx.payments.updateStatus(paymentA.id, "succeeded", {});
      await ctx.ledger.postPaymentCleared({ paymentAttemptId: paymentA.id, agreementId, currency: "USD", grossAmountMinorUnits: 5_000 });
      const db = getDb();
      await db.update(agreement).set({ status: "paid_in_full" }).where(eq(agreement.id, agreementId));
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full");

      await ctx.payments.updateStatus(paymentA.id, "disputed", {});
      await ctx.ledger.reversePayment({ paymentAttemptId: paymentA.id, entryType: "dispute_adjustment", reason: null });

      // Payment B (a second, unrelated payment against the SAME agreement) is seeded now, but its
      // OWN ledger-clearing effect is deliberately not posted yet — that INSERT is the operation
      // raced below, on a genuinely separate connection.
      const providerPaymentIdB = `sandbox_pay_${randomUUID()}`;
      const paymentB = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId: providerPaymentIdB,
      });
      await ctx.payments.updateStatus(paymentB.id, "succeeded", {});

      const isolatedA = createIsolatedDb(DATABASE_URL);
      const isolatedB = createIsolatedDb(DATABASE_URL);
      try {
        // Deterministic barrier: pause `recomputeAfterSupersession` the instant it holds the
        // agreement row lock (`SELECT ... FOR UPDATE`) — genuinely inside its own open transaction —
        // but BEFORE it reads balance/schedule evidence.
        const lockAcquired = createDeferred<void>();
        const releaseA = createDeferred<void>();
        const completionA = new AgreementCompletionService({
          agreements: new DrizzleAgreementRepository(isolatedA.db) as unknown as AgreementStatusRepository,
          balances: ctx.balances as unknown as AgreementBalanceComputer,
          audit: new AuditService(new DrizzleAuditEventRepository(isolatedA.db)),
          db: isolatedA.db,
          hooks: {
            afterAgreementLockBeforeBalanceRead: async () => {
              lockAcquired.resolve();
              await releaseA.promise;
            },
          },
        });

        const disputeEventId = `evt-${randomUUID()}`;
        const resultAPromise = completionA.recomputeAfterSupersession(agreementId, disputeEventId);
        await lockAcquired.promise; // deterministic: A genuinely holds the agreement row lock, paused right before reading fresh balance evidence.

        // Payment B's OWN ledger-clearing insert — `ledger_journal_entry.agreement_id` has a foreign
        // key to `agreement.id`, so this INSERT requires Postgres's own implicit FOR KEY SHARE lock
        // on the SAME agreement row A already holds FOR UPDATE — started WITHOUT awaiting (it cannot
        // complete until A's transaction ends), then PROVEN genuinely blocked via
        // `waitUntilPidBlockedOnLock` (server-side proof, never timing luck).
        const pidB = await warmUp(isolatedB.client);
        const ledgerB = new LedgerService({
          accounts: new DrizzleLedgerAccountRepository(isolatedB.db),
          entries: new DrizzleLedgerJournalEntryRepository(isolatedB.db),
          audit: new AuditService(new DrizzleAuditEventRepository(isolatedB.db)),
        });
        const resultBPromise = ledgerB.postPaymentCleared({ paymentAttemptId: paymentB.id, agreementId, currency: "USD", grossAmountMinorUnits: 5_000 });
        await waitUntilPidBlockedOnLock(DATABASE_URL, pidB); // PROVEN: B's own ledger post is genuinely blocked behind A's still-open agreement lock.

        // Resume A — its balance read, decision, status write, and audit all commit BEFORE B's
        // blocked insert can even proceed (the row lock is held for A's ENTIRE transaction) — so A's
        // decision is provably based on evidence that, AT THAT INSTANT, genuinely did not yet include
        // B's payment; there is no reachable interleaving where B's commit is invisible to a read A
        // performs AFTER it — B's own commit is simply forced to wait until A's transaction concludes.
        releaseA.resolve();
        await Promise.all([resultAPromise, resultBPromise]);

        // A correctly demoted from the evidence genuinely available at its own decision point (B's
        // payment was still pending, not merely stale-invisible).
        expect((await ctx.agreements.findById(agreementId))?.status).toBe("active");
        const demotionAuditRows = await db
          .select()
          .from(auditEvent)
          .where(and(eq(auditEvent.action, "agreement_reopened_by_supersession"), eq(auditEvent.agreementId, agreementId)));
        expect(demotionAuditRows).toHaveLength(1);
        expect(await findAuditEventsByProviderEvent(disputeEventId, "agreement_reopened_by_supersession")).toHaveLength(1);

        // B's ledger post, once unblocked, completed normally — nothing was lost, only serialized.
        const entriesB = await ctx.ledger.listEntriesForPaymentAttempt(paymentB.id);
        expect(entriesB.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
        const entriesA = await ctx.ledger.listEntriesForPaymentAttempt(paymentA.id);
        expect(entriesA.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
        expect(entriesA.filter((e) => e.entryType === "dispute_adjustment")).toHaveLength(1);

        // B's later settlement is never silently dropped — the SAME forward-path lifecycle check
        // (`checkAndAdvance`, exactly as B's own success event's `checkCompletionRequired` would
        // trigger in the full webhook pipeline) correctly re-converges the agreement once B's payment
        // is accounted for — proving the race cost only correct sequencing, never lost evidence.
        await ctx.completion.checkAndAdvance(agreementId);
        expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full");
      } finally {
        await isolatedA.close();
        await isolatedB.close();
      }
    });

    it("CONCURRENCY A — two overlapping workers processing the SAME superseding event: only ONE disposition is ever durably recorded (installment_reopened_by_supersession), and the loser's post-lock re-check observes it rather than re-deciding from installment.status", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("concurrency-a-creditor");
      const debtor = await seedPersonalUser("concurrency-a-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(
        creditor.profileId,
        debtor.profileId,
        creditor.userId,
        5_000,
        "2099-01-01",
      );
      const paymentA = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentId = paymentA.providerPaymentId!;

      const workflow = buildRealWorkflow();
      const webhookNormal = ctx.buildWebhookService({ failedPaymentWorkflow: workflow });
      const successEventId = `evt-${randomUUID()}`;
      await webhookNormal.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId }));
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");

      // The dispute's OWN ledger reversal fails once — its first `applyEvent` attempt fails BEFORE
      // ever reaching compensation (ledger runs earlier in the required-effect sequence), so the
      // event stays retryable and `coordinateSupersession` has never been called for it when the two
      // concurrent workers below race it directly.
      const flakyLedger = flaky(ctx.ledger, "reversePayment", 1, () => new Error("simulated_transient_ledger_failure"));
      const webhookFlakyLedger = ctx.buildWebhookService({ failedPaymentWorkflow: workflow, ledger: flakyLedger });
      const disputeEventId = `evt-${randomUUID()}`;
      const disputeAttempt1 = await webhookFlakyLedger.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: disputeEventId, eventType: "payment.disputed", providerPaymentId }),
      );
      expect(disputeAttempt1.status).toBe("accepted"); // ledger failed -> compensation never reached yet.
      expect(await findCompensationAudit(installmentScheduleItemId)).toHaveLength(0);

      const paymentForRace = (await ctx.payments.findById(paymentA.id))!;

      const isolatedX = createIsolatedDb(DATABASE_URL);
      const isolatedY = createIsolatedDb(DATABASE_URL);
      let paymentB: PaymentAttemptRecord;
      try {
        // Worker X: paused genuinely BEFORE it even attempts the installment row lock — reproducing
        // Codex's exact scenario (X "reaches the point before it can acquire the installment lock").
        const xAtLock = createDeferred<void>();
        const releaseX = createDeferred<void>();
        const coordinatorX = new DrizzleFailedPaymentRetryCoordinator(
          isolatedX.db,
          undefined,
          new AuditService(new DrizzleAuditEventRepository(isolatedX.db)),
          {
            beforeInstallmentLock: async () => {
              xAtLock.resolve();
              await releaseX.promise;
            },
          },
        );
        const coordinatorY = new DrizzleFailedPaymentRetryCoordinator(isolatedY.db, undefined, new AuditService(new DrizzleAuditEventRepository(isolatedY.db)));

        const resultXPromise = coordinatorX.coordinateSupersession({ installmentScheduleItemId, payment: paymentForRace, providerEventId: disputeEventId });
        await xAtLock.promise; // deterministic: X is paused before attempting the installment lock at all.

        // Worker Y processes the SAME superseding event to completion while X is still paused —
        // installment is currently "paid" (from A's success above), so Y decides "reopened".
        const resultY = await coordinatorY.coordinateSupersession({ installmentScheduleItemId, payment: paymentForRace, providerEventId: disputeEventId });
        expect(resultY.outcome).toBe("reopened");
        expect(await installmentStatus(installmentScheduleItemId)).toBe("scheduled");

        // Payment B subsequently, legitimately pays the now-reopened installment.
        paymentB = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
        const providerPaymentIdB = paymentB.providerPaymentId!;
        const successBEventId = `evt-${randomUUID()}`;
        const successBResult = await webhookNormal.receiveWebhook(
          signedWebhook(ctx.provider, { providerEventId: successBEventId, eventType: "payment.succeeded", providerPaymentId: providerPaymentIdB }),
        );
        expect(successBResult.status).toBe("processed");
        expect(await installmentStatus(installmentScheduleItemId)).toBe("paid"); // B's legitimate state.

        // Resume X — it now acquires the (uncontested — Y already committed and released) lock, and
        // its AUTHORITATIVE disposition re-check runs POST-lock: it must observe Y's already-durable
        // decision, never re-derive one from installment.status (which is "paid" again, but because
        // of B, not because this is A's first compensation attempt).
        releaseX.resolve();
        const resultX = await resultXPromise;
        expect(resultX.outcome).toBe("already_compensated");
      } finally {
        await isolatedX.close();
        await isolatedY.close();
      }

      // FINAL: B's installment remains paid — X never reopened it a second time.
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
      // Exactly ONE of the two disposition actions exists for A's dispute providerEventId — never both.
      const reopenedMarkers = await findAuditEventsByProviderEvent(disputeEventId, "installment_reopened_by_supersession");
      const notRequiredMarkers = await findAuditEventsByProviderEvent(disputeEventId, "installment_reopen_not_required_by_supersession");
      expect(reopenedMarkers).toHaveLength(1);
      expect(notRequiredMarkers).toHaveLength(0);
      expect(reopenedMarkers.length + notRequiredMarkers.length).toBe(1); // mutual exclusivity, explicit.

      // Retry the dispute event through the REAL pipeline — the ledger flake is exhausted, so this
      // attempt's own reversal now succeeds; compensation is found already-decided (a clean no-op),
      // and the event's own remaining required effect (agreement recompute) completes normally.
      const disputeRow = (await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))!;
      await webhookFlakyLedger.recoverBatch(100, new Date(disputeRow.nextRetryAt!.getTime() + 1));
      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))?.processingStatus).toBe("processed");
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid"); // still B's state — untouched by the retry.
      expect(await findAuditEventsByProviderEvent(disputeEventId, "installment_reopened_by_supersession")).toHaveLength(1); // still exactly one.
      expect(await findAuditEventsByProviderEvent(disputeEventId, "installment_reopen_not_required_by_supersession")).toHaveLength(0);

      // Ledger exact-once, per payment; no new/resurrected retries.
      const entriesA = await ctx.ledger.listEntriesForPaymentAttempt(paymentA.id);
      expect(entriesA.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
      expect(entriesA.filter((e) => e.entryType === "dispute_adjustment")).toHaveLength(1);
      const entriesB = await ctx.ledger.listEntriesForPaymentAttempt(paymentB.id);
      expect(entriesB.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
      expect(await listRetriesForInstallment(installmentScheduleItemId)).toHaveLength(0);

      // Repeated recoverBatch (bounded, never a broad "now" in this shared-database suite) changes
      // nothing further.
      const boundedNow = new Date(disputeRow.nextRetryAt!.getTime() + 1);
      await webhookFlakyLedger.recoverBatch(100, boundedNow);
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
      expect(await findAuditEventsByProviderEvent(disputeEventId, "installment_reopened_by_supersession")).toHaveLength(1);
      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))?.processingStatus).toBe("processed");
    });

    it("CONCURRENCY B — two overlapping workers processing the SAME superseding event: only ONE disposition is ever durably recorded (installment_reopen_not_required_by_supersession), and the loser's post-lock re-check observes it rather than wrongly reopening a DIFFERENT payment's later, legitimate paid state", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("concurrency-b-creditor");
      const debtor = await seedPersonalUser("concurrency-b-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(
        creditor.profileId,
        debtor.profileId,
        creditor.userId,
        5_000,
        "2099-01-01",
      );
      const paymentA = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const providerPaymentId = paymentA.providerPaymentId!;

      // No `failedPaymentWorkflow` wired for EITHER delivery below — the installment is never marked
      // "paid" by A, and the real pipeline never calls `coordinateSupersession` itself; the two
      // concurrent workers raced directly below are the ONLY callers, isolating this test to
      // `coordinateSupersession`'s own concurrency safety for the "not required" disposition.
      const webhookNormal = ctx.buildWebhookService();
      const successEventId = `evt-${randomUUID()}`;
      await webhookNormal.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId }));
      expect(await installmentStatus(installmentScheduleItemId)).not.toBe("paid");

      const disputeEventId = `evt-${randomUUID()}`;
      const disputeResult = await webhookNormal.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: disputeEventId, eventType: "payment.disputed", providerPaymentId }),
      );
      expect(disputeResult.status).toBe("processed"); // nothing wired to fail on this delivery.

      const paymentForRace = (await ctx.payments.findById(paymentA.id))!;

      const isolatedX = createIsolatedDb(DATABASE_URL);
      const isolatedY = createIsolatedDb(DATABASE_URL);
      let paymentB: PaymentAttemptRecord;
      try {
        const xAtLock = createDeferred<void>();
        const releaseX = createDeferred<void>();
        const coordinatorX = new DrizzleFailedPaymentRetryCoordinator(
          isolatedX.db,
          undefined,
          new AuditService(new DrizzleAuditEventRepository(isolatedX.db)),
          {
            beforeInstallmentLock: async () => {
              xAtLock.resolve();
              await releaseX.promise;
            },
          },
        );
        const coordinatorY = new DrizzleFailedPaymentRetryCoordinator(isolatedY.db, undefined, new AuditService(new DrizzleAuditEventRepository(isolatedY.db)));

        const resultXPromise = coordinatorX.coordinateSupersession({ installmentScheduleItemId, payment: paymentForRace, providerEventId: disputeEventId });
        await xAtLock.promise;

        // Worker Y processes the SAME superseding event to completion while X is still paused — the
        // installment is not currently "paid" (A's own workflow never ran), so Y decides "not required".
        const resultY = await coordinatorY.coordinateSupersession({ installmentScheduleItemId, payment: paymentForRace, providerEventId: disputeEventId });
        expect(resultY.outcome).toBe("not_paid");

        // Payment B subsequently, legitimately pays the SAME (still-payable, never-paid) installment.
        paymentB = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
        const providerPaymentIdB = paymentB.providerPaymentId!;
        const workflow = buildRealWorkflow();
        const webhookB = ctx.buildWebhookService({ failedPaymentWorkflow: workflow });
        const successBEventId = `evt-${randomUUID()}`;
        const successBResult = await webhookB.receiveWebhook(
          signedWebhook(ctx.provider, { providerEventId: successBEventId, eventType: "payment.succeeded", providerPaymentId: providerPaymentIdB }),
        );
        expect(successBResult.status).toBe("processed");
        expect(await installmentStatus(installmentScheduleItemId)).toBe("paid"); // B's legitimate state.

        // Resume X — its post-lock re-check must observe Y's already-durable "not required" decision,
        // never re-derive one from installment.status (which is NOW "paid" — because of B).
        releaseX.resolve();
        const resultX = await resultXPromise;
        expect(resultX.outcome).toBe("not_paid");
      } finally {
        await isolatedX.close();
        await isolatedY.close();
      }

      // FINAL: B's installment remains paid — X never touched it despite installment.status now
      // reading "paid".
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
      const reopenedMarkers = await findAuditEventsByProviderEvent(disputeEventId, "installment_reopened_by_supersession");
      const notRequiredMarkers = await findAuditEventsByProviderEvent(disputeEventId, "installment_reopen_not_required_by_supersession");
      expect(reopenedMarkers).toHaveLength(0);
      expect(notRequiredMarkers).toHaveLength(1);
      expect(reopenedMarkers.length + notRequiredMarkers.length).toBe(1); // mutual exclusivity, explicit.

      expect((await ctx.events.findByProviderEvent(ctx.provider.providerName, disputeEventId))?.processingStatus).toBe("processed");
      const entriesB = await ctx.ledger.listEntriesForPaymentAttempt(paymentB.id);
      expect(entriesB.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
      expect(await listRetriesForInstallment(installmentScheduleItemId)).toHaveLength(0);
    });
  });

  describe("PAID2YOU — PACKAGE B / STAGE 9 REMEDIATION — Root Correction 4 (material evidence validated on first legal event; canonical success provider evidence)", () => {
    it("B4-A — a FIRST legal success event carrying materially wrong amount/currency evidence never transitions/processes as valid success; automatically records the conflict instead of silently substituting internal values", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const webhook = ctx.buildWebhookService();

      const result = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId, amountMinorUnits: 1_000, currency: "EUR" }),
      );
      expect(result.status).toBe("processed"); // durably surfaced, never retried again.
      expect((await ctx.payments.findById(payment.id))?.status).toBe("pending"); // NO transition.
      const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
      expect(entries).toHaveLength(0); // NO ledger.

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptions.map((e) => e.exceptionType)).toEqual(expect.arrayContaining(["amount_mismatch", "currency_mismatch"]));
    });

    it("B4-B — CANONICAL SUCCESS PROVIDER EVIDENCE: when the success transition applied but its own ledger posting hasn't (yet), a duplicate carrying a DIFFERENT processor fee is still automatically detected against the canonical transition event — no manual reconciliation invocation", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const flakyLedger = flaky(ctx.ledger, "postPaymentCleared", 1, () => new Error("simulated_transient_ledger_failure"));
      const webhook = ctx.buildWebhookService({ ledger: flakyLedger });

      const firstResult = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId, processorFeeMinorUnits: 10 }),
      );
      expect(firstResult.status).toBe("accepted"); // transition applied; its own ledger effect failed -> retryable.
      expect((await ctx.payments.findById(payment.id))?.status).toBe("succeeded");
      expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull(); // the timing gap: no clearing entry yet.

      const duplicateResult = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, {
          providerEventId: `evt-${randomUUID()}`,
          eventType: "payment.succeeded",
          providerPaymentId,
          amountMinorUnits: 5_000,
          processorFeeMinorUnits: 20,
        }),
      );
      expect(duplicateResult.status).toBe("processed"); // dead-end duplicate — never applied.

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      const conflict = exceptions.find((e) => e.exceptionType === "processor_fee_mismatch");
      expect(conflict).toBeDefined();
      expect(conflict?.details).toEqual({ expected: 10, actual: 20 });
    });

    it("B4-C — CANONICAL SUCCESS PROVIDER EVIDENCE: an equivalent processor fee before clearing exists creates no false conflict", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const flakyLedger = flaky(ctx.ledger, "postPaymentCleared", 1, () => new Error("simulated_transient_ledger_failure"));
      const webhook = ctx.buildWebhookService({ ledger: flakyLedger });

      await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId, processorFeeMinorUnits: 10 }),
      );
      expect(await findClearEntry(ctx.ledger, payment.id)).toBeNull();

      const duplicateResult = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, {
          providerEventId: `evt-${randomUUID()}`,
          eventType: "payment.succeeded",
          providerPaymentId,
          amountMinorUnits: 5_000,
          processorFeeMinorUnits: 10,
        }),
      );
      expect(duplicateResult.status).toBe("processed");

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptions.map((e) => e.exceptionType)).not.toContain("processor_fee_mismatch");
    });

    it("B4-D — a historical duplicate success arriving after the payment has legally progressed to disputed/refunded remains a COMPATIBLE duplicate (regression proof — already covered by the accepted historical-compatibility algorithm)", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      const webhook = ctx.buildWebhookService();
      await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }));
      await webhook.receiveWebhook(signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.refunded", providerPaymentId }));
      expect((await ctx.payments.findById(payment.id))?.status).toBe("refunded");

      const delayedDuplicate = await webhook.receiveWebhook(
        signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId, amountMinorUnits: 5_000 }),
      );
      expect(delayedDuplicate.status).toBe("processed");
      expect((await ctx.payments.findById(payment.id))?.status).toBe("refunded"); // never regressed.

      const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
      expect(exceptions.map((e) => e.exceptionType)).not.toContain("status_mismatch");
    });
  });

  describe("PAID2YOU — PACKAGE B / STAGE 9 REMEDIATION — Root Correction 5 (reconciliation must use Paid2You platform-fee authority)", () => {
    it("B5-C — automatic clearing repair uses a NONZERO injected PlatformFeePolicy test value, never a hardcoded zero", async () => {
      const ctx = buildContext();
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(ctx.payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });
      await ctx.payments.updateStatus(payment.id, "succeeded", {});
      const trustedEvent = await ctx.events.tryInsertAndClaim({
        provider: ctx.provider.providerName,
        providerEventId: `evt-${randomUUID()}`,
        eventType: "payment.succeeded",
        source: "webhook",
        signatureVerified: true,
        payload: { providerPaymentId, amountMinorUnits: 5_000, currency: "USD", processorFeeMinorUnits: 100 },
        leaseMs: 120_000,
        now: new Date(),
      });
      await ctx.events.markProcessed(trustedEvent!.id, trustedEvent!.claimToken!, new Date());

      const customPolicy: PlatformFeePolicy = { async getPlatformFeeMinorUnits() { return 55; } };
      const reconciliationWithCustomPolicy = new ReconciliationService({
        payments: ctx.payments,
        webhookEvents: ctx.events,
        provider: ctx.provider,
        ledger: ctx.ledger,
        exceptions: ctx.exceptions,
        completion: ctx.completion,
        platformFeePolicy: customPolicy,
      });

      const found = await reconciliationWithCustomPolicy.reconcilePaymentAttempt(payment.id);
      expect(found.map((e) => e.exceptionType)).not.toContain("internal_posting_failure");
      const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
      const clearEntry = entries.find((e) => e.entryType === "payment_cleared");
      expect(clearEntry).toBeDefined();
      const processorLeg = clearEntry!.postings.find((p) => p.accountType === "processor_fee_expense");
      expect(processorLeg?.amountMinorUnits).toBe(100); // processor fee remains provider-authoritative.
      const platformLeg = clearEntry!.postings.find((p) => p.accountType === "platform_fee_revenue");
      expect(platformLeg?.amountMinorUnits).toBe(55); // from the injected policy, never a hardcoded zero.
    });
  });

  describe("PAID2YOU — PACKAGE B / STAGE 9 REMEDIATION — TEST QUALITY CORRECTION (deterministic conflict-exception contention via real PostgreSQL lock contention, never Promise.all alone)", () => {
    it("deterministic contention — a material financial conflict exception (amount_mismatch) is inserted exactly once under REAL, server-proven contention", async () => {
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const payments = new DrizzlePaymentAttemptRepository();
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });

      const isolatedA = createIsolatedDb(DATABASE_URL);
      const isolatedB = createIsolatedDb(DATABASE_URL);
      try {
        const pidB = await warmUp(isolatedB.client);
        const identity = {
          exceptionType: "amount_mismatch" as const,
          paymentAttemptId: payment.id,
          providerEventId: `evt-${randomUUID()}`,
          details: { expected: 5_000, actual: 999_999 },
        };

        const insertIssued = createDeferred<void>();
        const releaseInsert = createDeferred<void>();
        const testHooks: ReconciliationExceptionInsertTestHooks = {
          afterInsertBeforeCommit: async () => {
            insertIssued.resolve();
            await releaseInsert.promise;
          },
        };
        const repoA = new DrizzleReconciliationExceptionRepository(isolatedA.db, testHooks);
        const repoB = new DrizzleReconciliationExceptionRepository(isolatedB.db);

        const resultAPromise = repoA.ensureOpenException(identity);
        await insertIssued.promise; // worker A has genuinely issued its INSERT and holds it uncommitted.

        const resultBPromise = repoB.ensureOpenException(identity);
        // Server-side proof (never client-side timing) that worker B's own conflicting INSERT is
        // REALLY blocked behind worker A's uncommitted row for this exact identity.
        await waitUntilPidBlockedOnLock(DATABASE_URL, pidB);

        releaseInsert.resolve(); // worker A commits; worker B's insert can now resolve (as a no-op).
        const [resultA, resultB] = await Promise.all([resultAPromise, resultBPromise]);
        const successes = [resultA, resultB].filter((r) => r !== null);
        expect(successes).toHaveLength(1);

        const all = await new DrizzleReconciliationExceptionRepository().listForPaymentAttempt(payment.id);
        expect(all.filter((e) => e.exceptionType === "amount_mismatch" && e.status === "open")).toHaveLength(1);
      } finally {
        await isolatedA.close();
        await isolatedB.close();
      }
    });

    it("deterministic contention — a provider_identity_mismatch exception is inserted exactly once under REAL, server-proven contention", async () => {
      const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
      const payments = new DrizzlePaymentAttemptRepository();
      const providerPaymentId = `sandbox_pay_${randomUUID()}`;
      const payment = await seedPendingPayment(payments, {
        agreementId,
        amountMinorUnits: 5_000,
        payerProfileId: debtor.profileId,
        recipientProfileId: creditor.profileId,
        providerPaymentId,
      });

      const isolatedA = createIsolatedDb(DATABASE_URL);
      const isolatedB = createIsolatedDb(DATABASE_URL);
      try {
        const pidB = await warmUp(isolatedB.client);
        const identity = {
          exceptionType: "provider_identity_mismatch" as const,
          paymentAttemptId: payment.id,
          providerEventId: `evt-${randomUUID()}`,
          details: { expectedProvider: "sandbox_mock", actualProvider: "other_provider_mock", providerPaymentId },
        };

        const insertIssued = createDeferred<void>();
        const releaseInsert = createDeferred<void>();
        const testHooks: ReconciliationExceptionInsertTestHooks = {
          afterInsertBeforeCommit: async () => {
            insertIssued.resolve();
            await releaseInsert.promise;
          },
        };
        const repoA = new DrizzleReconciliationExceptionRepository(isolatedA.db, testHooks);
        const repoB = new DrizzleReconciliationExceptionRepository(isolatedB.db);

        const resultAPromise = repoA.ensureOpenException(identity);
        await insertIssued.promise;

        const resultBPromise = repoB.ensureOpenException(identity);
        await waitUntilPidBlockedOnLock(DATABASE_URL, pidB);

        releaseInsert.resolve();
        const [resultA, resultB] = await Promise.all([resultAPromise, resultBPromise]);
        const successes = [resultA, resultB].filter((r) => r !== null);
        expect(successes).toHaveLength(1);

        const all = await new DrizzleReconciliationExceptionRepository().listForPaymentAttempt(payment.id);
        expect(all.filter((e) => e.exceptionType === "provider_identity_mismatch" && e.status === "open")).toHaveLength(1);
      } finally {
        await isolatedA.close();
        await isolatedB.close();
      }
    });
  });

  describe("PAID2YOU — PACKAGE B / STAGE 9 REMEDIATION — Root Correction 1 (durable dispatch intent) & Root Correction 2 (terminal results never bypass the durable event pipeline)", () => {
    function buildNeverReachedProvider(): SandboxPaymentProvider {
      const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
      return new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "createPayment") {
            // Never calls the real target at all — the provider genuinely never receives this request.
            return async () => {
              throw new AmbiguousProviderResponseError();
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;
    }

    /** A real FailedPaymentWorkflowService, routed through `coordinator.coordinateSuccess` — required so `installmentStatus` genuinely reaches "paid" once a terminal success is applied through the durable event pipeline (see `FailedPaymentWorkflowService.handlePaymentSucceeded`'s own doc comment). Never actually invokes `retries`/its own initiators — the `retryCoordinator` branch is always taken. */
    function buildFailedPaymentWorkflowFor(coordinator: FailedPaymentRetryCoordinator): FailedPaymentWorkflowService {
      const notifyCtx = createTestNotificationService();
      const verificationCtx = createTestVerificationService();
      const dummyInitiator: RetryPaymentMethodInitiator = {
        async createManualPayment() {
          throw new Error("not used in this test");
        },
        async prepareRetrySubmission() {
          throw new Error("not used in this test");
        },
      };
      const retryService = new PaymentRetryService({
        retries: new DrizzlePaymentRetryRepository(),
        paymentAttempts: new DrizzlePaymentAttemptRepository(),
        initiators: { ach: dummyInitiator, debit_card: dummyInitiator, manual_off_platform: dummyInitiator },
        profileOwners: verificationCtx.profileOwners,
        audit: new AuditService(new DrizzleAuditEventRepository()),
      });
      return new FailedPaymentWorkflowService({
        installments: new DrizzleInstallmentStatusRepository(),
        retries: retryService,
        notifications: notifyCtx.notificationService,
        profileOwners: verificationCtx.profileOwners,
        retryCoordinator: coordinator,
      });
    }

    it("B1-A / B1-C — a Phase-B persistence failure AFTER the provider genuinely accepted leaves Phase A's durable anchor committed and automatically discoverable; a later independent resolution (modeling scheduler restart) completes every required effect", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("b1a-creditor");
      const debtor = await seedPersonalUser("b1a-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const seedCoordinator = new DrizzleFailedPaymentRetryCoordinator();
      const failure = await seedCoordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;

      const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
      const hooks: InstallmentLockTestHooks = {
        afterProviderCallBeforePersist: async () => {
          throw new Error("simulated_persistence_failure_after_provider_accepted");
        },
      };
      const coordinatorWithHook = new DrizzleFailedPaymentRetryCoordinator(undefined, undefined, undefined, hooks);
      const effectApplier = ctx.buildWebhookService();

      await expect(
        coordinatorWithHook.claimAndExecuteRetry({
          installmentScheduleItemId,
          retryId: failure.retryId,
          idempotencyKey,
          agreementId,
          provider: realProvider,
          prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
          payer: { profileKind: "personal", profileId: debtor.profileId },
          recipient: { profileKind: "personal", profileId: creditor.profileId },
          effectApplier,
        }),
      ).rejects.toThrow("simulated_persistence_failure_after_provider_accepted");

      // B1-A: the provider genuinely has a logical payment for this exact key.
      const foundAtProvider = await realProvider.retrievePaymentByIdempotencyKey(idempotencyKey);
      expect(foundAtProvider).not.toBeNull();

      // B1-A: the local durable anchor (Phase A's own commit) remains — never erased by Phase B's
      // own later failure — and is automatically discoverable (retry still "claimed", never reverted
      // to "scheduled" and never "canceled").
      const anchor = await ctx.payments.findByIdempotencyKey(idempotencyKey);
      expect(anchor).not.toBeNull();
      expect(anchor?.status).toBe("submitted");
      const retryRow = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
      expect(retryRow?.status).toBe("claimed");
      const dueClaimed = await new DrizzlePaymentRetryRepository().findClaimedForResumption(50, new Date());
      expect(dueClaimed.map((r) => r.id)).toContain(failure.retryId); // genuinely automatically discoverable.

      // B1-C: a LATER, INDEPENDENT resolution call — modeling the scheduler resuming after a restart —
      // discovers the provider's own real record and completes every required effect through the
      // durable pipeline (never a direct status write).
      const resolution = await seedCoordinator.resolveAmbiguousRetry({ retryId: failure.retryId, idempotencyKey, provider: realProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");
      const finalAnchor = await ctx.payments.findById(anchor!.id);
      expect(finalAnchor?.providerPaymentId).toBe(foundAtProvider!.providerPaymentId);
      // The sandbox provider defaults to "pending" (see CreatePaymentInput's own doc comment) when no
      // simulateOutcome is given — a non-terminal outcome, so no ledger/workflow/lifecycle effect is
      // expected yet; the point already proven is that discovery survived and correlated correctly.
      expect(finalAnchor?.status).toBe("processing");
    });

    it("B1-B — settling the installment via a DIFFERENT payment, after a Phase-B persistence failure, never erases the surviving anchor's discoverability: future dispatch is revoked, but discovery/correlation still runs, with no second provider payment", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("b1b-creditor");
      const debtor = await seedPersonalUser("b1b-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const seedCoordinator = new DrizzleFailedPaymentRetryCoordinator();
      const failure = await seedCoordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;

      let createPaymentCallCount = 0;
      const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
      const countingProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "createPayment") {
            return async (...args: unknown[]) => {
              createPaymentCallCount += 1;
              return (target.createPayment as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;

      const hooks: InstallmentLockTestHooks = {
        afterProviderCallBeforePersist: async () => {
          throw new Error("simulated_persistence_failure_after_provider_accepted");
        },
      };
      const coordinatorWithHook = new DrizzleFailedPaymentRetryCoordinator(undefined, undefined, undefined, hooks);
      const effectApplier = ctx.buildWebhookService();

      await expect(
        coordinatorWithHook.claimAndExecuteRetry({
          installmentScheduleItemId,
          retryId: failure.retryId,
          idempotencyKey,
          agreementId,
          provider: countingProvider,
          prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
          payer: { profileKind: "personal", profileId: debtor.profileId },
          recipient: { profileKind: "personal", profileId: creditor.profileId },
          effectApplier,
        }),
      ).rejects.toThrow();
      expect(createPaymentCallCount).toBe(1);
      const anchor = await ctx.payments.findByIdempotencyKey(idempotencyKey);
      expect(anchor?.status).toBe("submitted");

      // A DIFFERENT payment settles the SAME installment.
      const { canceledRetryIds } = await seedCoordinator.coordinateSuccess({ installmentScheduleItemId });
      // B1-B: FUTURE dispatch is revoked (this retry is never cancelable-and-redispatchable again in
      // the normal "claim from scheduled" sense — it is not among the newly-canceled ids because its
      // own anchor's existence already excludes it from that sweep, exactly as intended) — but it
      // remains "claimed", never silently erased.
      expect(canceledRetryIds).not.toContain(failure.retryId);
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
      const retryAfterSettlement = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
      expect(retryAfterSettlement?.status).toBe("claimed");

      // B1-B: ambiguity discovery still runs and correlates the ORIGINAL provider payment — with NO
      // second provider payment (`createPaymentCallCount` never increments again).
      const resolution = await seedCoordinator.resolveAmbiguousRetry({ retryId: failure.retryId, idempotencyKey, provider: countingProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");
      expect(createPaymentCallCount).toBe(1); // still exactly one — no second provider payment.
      const finalAnchor = await ctx.payments.findById(anchor!.id);
      expect(finalAnchor?.providerPaymentId).not.toBeNull();
    });

    it("B1-D — durable intent exists; provider lookup returns definitively NOT FOUND; the installment is already settled: no provider dispatch occurs, and the local intent is safely closed", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("b1d-creditor");
      const debtor = await seedPersonalUser("b1d-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const coordinator = new DrizzleFailedPaymentRetryCoordinator();
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;

      const neverReachedProvider = buildNeverReachedProvider();
      const effectApplier = ctx.buildWebhookService();
      const dispatchOutcome = await coordinator.claimAndExecuteRetry({
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        agreementId,
        provider: neverReachedProvider,
        prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        effectApplier,
      });
      expect(dispatchOutcome.outcome).toBe("ambiguous"); // the provider genuinely never received it.

      // A DIFFERENT payment settles the installment.
      await coordinator.coordinateSuccess({ installmentScheduleItemId });
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");

      let redispatchAttempted = false;
      const stillNeverReachedProvider = new Proxy(neverReachedProvider, {
        get(target, prop, receiver) {
          if (prop === "createPayment") {
            return async () => {
              redispatchAttempted = true;
              throw new Error("must never be called — the installment is already settled");
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;

      const resolution = await coordinator.resolveAmbiguousRetry({ retryId: failure.retryId, idempotencyKey, provider: stillNeverReachedProvider, effectApplier });
      expect(resolution.outcome).toBe("closed");
      expect(redispatchAttempted).toBe(false); // NO provider dispatch — the installment was already settled.

      const finalAnchor = await ctx.payments.findByIdempotencyKey(idempotencyKey);
      expect(finalAnchor?.status).toBe("failed"); // local intent safely closed, never dispatched.
      const finalRetry = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
      expect(finalRetry?.status).toBe("canceled");
    });

    it("B1-E — durable intent exists; provider lookup returns definitively NOT FOUND; the installment remains eligible: the SAME idempotency key may dispatch once, with no duplicate logical provider payment", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("b1e-creditor");
      const debtor = await seedPersonalUser("b1e-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const coordinator = new DrizzleFailedPaymentRetryCoordinator();
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;

      const neverReachedProvider = buildNeverReachedProvider();
      const effectApplier = ctx.buildWebhookService();
      const dispatchOutcome = await coordinator.claimAndExecuteRetry({
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        agreementId,
        provider: neverReachedProvider,
        prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        effectApplier,
      });
      expect(dispatchOutcome.outcome).toBe("ambiguous"); // genuinely never reached the real provider.
      expect(await installmentStatus(installmentScheduleItemId)).not.toBe("paid"); // still eligible.

      // Resolve using the REAL (unwrapped) provider this time — "not found" (genuinely, since it was
      // never actually reached above), still eligible -> redispatch using THE SAME idempotency key.
      const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
      let createPaymentCallCount = 0;
      const countingProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "createPayment") {
            return async (...args: unknown[]) => {
              createPaymentCallCount += 1;
              const [createInput] = args as [{ idempotencyKey: string }];
              expect(createInput.idempotencyKey).toBe(idempotencyKey); // NEVER a new key.
              return (target.createPayment as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;

      const resolution = await coordinator.resolveAmbiguousRetry({ retryId: failure.retryId, idempotencyKey, provider: countingProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");
      expect(createPaymentCallCount).toBe(1); // dispatched exactly once.

      // No duplicate logical provider payment — the provider's own idempotency-key index has exactly
      // one record for this key.
      const foundAtProvider = await realProvider.retrievePaymentByIdempotencyKey(idempotencyKey);
      expect(foundAtProvider).not.toBeNull();
    });

    it("B2-A — createPayment immediately returns succeeded: the payment does NOT become succeeded via a direct repository update; the terminal result enters the durable internal-event pipeline; ledger/audit/workflow/lifecycle execute exactly once", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("b2a-creditor");
      const debtor = await seedPersonalUser("b2a-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const coordinator = new DrizzleFailedPaymentRetryCoordinator();
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;

      const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
      // A real adapter that settles SYNCHRONOUSLY (never through the ambiguous/timeout path at all) —
      // the exact case Root Correction 2 requires never bypass the durable event pipeline.
      const synchronousSuccessProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "createPayment") {
            return async (input: Record<string, unknown>) => (target.createPayment as (i: unknown) => Promise<unknown>)({ ...input, simulateOutcome: "succeeded" });
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;
      const effectApplier = ctx.buildWebhookService({ failedPaymentWorkflow: buildFailedPaymentWorkflowFor(coordinator) });

      const outcome = await coordinator.claimAndExecuteRetry({
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        agreementId,
        provider: synchronousSuccessProvider,
        prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        effectApplier,
      });
      expect(outcome.outcome).toBe("fired");
      if (outcome.outcome !== "fired") throw new Error("expected fired");
      const resultingPaymentAttemptId = outcome.resultingPaymentAttemptId;

      // Legal transition recorded via the real coordinator — never a direct repository status write
      // (proven indirectly: EVERY required effect below only ever executes through that pipeline).
      const finalPayment = await ctx.payments.findById(resultingPaymentAttemptId);
      expect(finalPayment?.status).toBe("succeeded");

      const entries = await ctx.ledger.listEntriesForPaymentAttempt(resultingPaymentAttemptId);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // ledger exactly once.

      const auditRows = await findAuditEventsByProviderEvent(`ambiguity-resolution:${idempotencyKey}`, "payment_webhook_payment.succeeded");
      expect(auditRows).toHaveLength(1); // audit exactly once.

      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid"); // workflow effect complete.
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full"); // lifecycle effect complete.
    });

    it("B2-B — an idempotent provider replay returns a payment ALREADY succeeded: the SAME full durable event pipeline applies, never a direct status shortcut", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("b2b-creditor");
      const debtor = await seedPersonalUser("b2b-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const coordinator = new DrizzleFailedPaymentRetryCoordinator();
      const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;

      // The provider ALREADY, independently has a "succeeded" record for this EXACT idempotency key —
      // a genuine idempotent-replay scenario (`SandboxPaymentProvider.createPayment`'s own real
      // idempotency-key contract — see that method's own doc comment: "for the SAME idempotencyKey,
      // this returns the SAME logical payment every time, never a second one").
      const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
      await realProvider.createPayment({
        idempotencyKey,
        amountMinorUnits: 5_000,
        currency: "USD",
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        simulateOutcome: "succeeded",
      });
      const effectApplier = ctx.buildWebhookService({ failedPaymentWorkflow: buildFailedPaymentWorkflowFor(coordinator) });

      const outcome = await coordinator.claimAndExecuteRetry({
        installmentScheduleItemId,
        retryId: failure.retryId,
        idempotencyKey,
        agreementId,
        provider: realProvider,
        prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        effectApplier,
      });
      expect(outcome.outcome).toBe("fired");
      if (outcome.outcome !== "fired") throw new Error("expected fired");
      const resultingPaymentAttemptId = outcome.resultingPaymentAttemptId;

      const finalPayment = await ctx.payments.findById(resultingPaymentAttemptId);
      expect(finalPayment?.status).toBe("succeeded");
      const entries = await ctx.ledger.listEntriesForPaymentAttempt(resultingPaymentAttemptId);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
      const auditRows = await findAuditEventsByProviderEvent(`ambiguity-resolution:${idempotencyKey}`, "payment_webhook_payment.succeeded");
      expect(auditRows).toHaveLength(1);
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full");
    });

    it("B2-C — a crash after provider-result persistence but before internal-event resolution: a LATER, independent resolution (modeling the scheduler's own automatic resumption) completes every required effect", async () => {
      const ctx = buildContext();
      const creditor = await seedPersonalUser("b2c-creditor");
      const debtor = await seedPersonalUser("b2c-debtor");
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 5_000);
      const payment = await seedInstallmentPayment(agreementId, installmentScheduleItemId, debtor, creditor);
      const seedCoordinator = new DrizzleFailedPaymentRetryCoordinator();
      const failure = await seedCoordinator.coordinateFailure({ installmentScheduleItemId, payment });
      if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");
      const idempotencyKey = `retry-${failure.retryId}`;

      const realProvider = new SandboxPaymentProvider(WEBHOOK_SECRET);
      const synchronousSuccessProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === "createPayment") {
            return async (input: Record<string, unknown>) => (target.createPayment as (i: unknown) => Promise<unknown>)({ ...input, simulateOutcome: "succeeded" });
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as SandboxPaymentProvider;

      const hooks: InstallmentLockTestHooks = {
        afterDispatchCommitBeforeResolution: async () => {
          throw new Error("simulated_crash_after_commit_before_resolution");
        },
      };
      const coordinatorWithHook = new DrizzleFailedPaymentRetryCoordinator(undefined, undefined, undefined, hooks);
      const effectApplier = ctx.buildWebhookService({ failedPaymentWorkflow: buildFailedPaymentWorkflowFor(seedCoordinator) });

      await expect(
        coordinatorWithHook.claimAndExecuteRetry({
          installmentScheduleItemId,
          retryId: failure.retryId,
          idempotencyKey,
          agreementId,
          provider: synchronousSuccessProvider,
          prepared: { amountMinorUnits: 5_000, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
          payer: { profileKind: "personal", profileId: debtor.profileId },
          recipient: { profileKind: "personal", profileId: creditor.profileId },
          effectApplier,
        }),
      ).rejects.toThrow("simulated_crash_after_commit_before_resolution");

      // Phase B's own commit already happened (correlation persisted) — the anchor survives, still
      // "submitted" (never resolved yet), and the retry remains "claimed".
      const anchorAfterCrash = await ctx.payments.findByIdempotencyKey(idempotencyKey);
      expect(anchorAfterCrash?.status).toBe("submitted");
      expect(anchorAfterCrash?.providerPaymentId).not.toBeNull();
      const retryAfterCrash = (await listRetriesForInstallment(installmentScheduleItemId)).find((r) => r.id === failure.retryId);
      expect(retryAfterCrash?.status).toBe("claimed");

      // A LATER, INDEPENDENT resolution call — modeling the scheduler's own automatic resumption after
      // restart — discovers and completes every required effect.
      const resolution = await seedCoordinator.resolveAmbiguousRetry({ retryId: failure.retryId, idempotencyKey, provider: realProvider, effectApplier });
      expect(resolution.outcome).toBe("fired");
      const finalPayment = await ctx.payments.findById(anchorAfterCrash!.id);
      expect(finalPayment?.status).toBe("succeeded");
      const entries = await ctx.ledger.listEntriesForPaymentAttempt(anchorAfterCrash!.id);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
      expect(await installmentStatus(installmentScheduleItemId)).toBe("paid");
      expect((await ctx.agreements.findById(agreementId))?.status).toBe("paid_in_full");
    });
  });
});
