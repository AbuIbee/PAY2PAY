import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agreement, agreementVersion } from "@/db/schema";
import { getDb } from "@/db/client";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { eq } from "drizzle-orm";
import { ValidationError } from "@/lib/errors";
import { DrizzleLedgerAccountRepository } from "@/lib/ledger/drizzleLedgerAccountRepository";
import { DrizzleLedgerJournalEntryRepository } from "@/lib/ledger/drizzleLedgerJournalEntryRepository";
import { LedgerService } from "@/lib/ledger/ledgerService";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { createIsolatedDb } from "../../../test/postgres/testDb";
import { DrizzleAtomicPayoutConfirmer } from "./atomicPayoutConfirmer";
import { DrizzleAtomicPayoutReturner } from "./atomicPayoutReturner";
import { DrizzlePayoutAttemptRepository } from "./drizzlePayoutAttemptRepository";
import { PayoutService } from "./payoutService";

const DATABASE_URL = process.env.DATABASE_URL!;

/**
 * PAID2YOU — B0-D PHASE 3B (G4: mandatory real-Postgres proof). Restores, against the NEW atomic
 * architecture (`DrizzleAtomicPayoutConfirmer`/`DrizzleAtomicPayoutReturner`), the class of proof the
 * deleted `R-B51` test (`paymentWebhookRecovery.postgres.test.ts`) provided for the now-removed
 * `payout.paid` webhook mechanism: real transaction/locking behavior that an in-memory fake cannot
 * meaningfully demonstrate. Every repository below is the real Drizzle implementation against a real,
 * disposable Postgres (see `scripts/postgres-test-db.mjs`, run via `npm run test:postgres`) — this
 * suite never runs against `.env.local` or any long-lived database; `vitest.postgres.setup.ts` refuses
 * to proceed unless `DATABASE_URL` points at a database this exact harness invocation provisioned and
 * marked with a fresh run token.
 */

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
      producedBy: "b0d_phase3b_postgres_test_seed",
      frequency: "monthly",
      feeAllocation: "creditor_pays",
      terms: { currentPrincipalMinorUnits: principalMinorUnits } as object,
    })
    .returning();
  if (!version) throw new Error("agreement_version insert returned no row");
  await db.update(agreement).set({ currentVersionId: version.id, status: "first_payment_pending" }).where(eq(agreement.id, created.id));
  return created.id;
}

async function seedTwoParties(principalMinorUnits = 10_000) {
  const creditor = await seedPersonalUser("b0d-3b-creditor");
  const debtor = await seedPersonalUser("b0d-3b-debtor");
  const agreementId = await seedAgreement(creditor.profileId, debtor.profileId, creditor.userId, principalMinorUnits);
  return { creditor, debtor, agreementId };
}

function buildContext() {
  const payments = new DrizzlePaymentAttemptRepository();
  const ledgerAccounts = new DrizzleLedgerAccountRepository();
  const ledgerEntries = new DrizzleLedgerJournalEntryRepository();
  const ledger = new LedgerService({ accounts: ledgerAccounts, entries: ledgerEntries, audit: new AuditService(new DrizzleAuditEventRepository()) });
  const payoutAttempts = new DrizzlePayoutAttemptRepository();

  function buildPayoutService(overrides: Partial<ConstructorParameters<typeof PayoutService>[0]> = {}) {
    return new PayoutService({
      payoutAttempts,
      ledger,
      payments,
      audit: new AuditService(new DrizzleAuditEventRepository()),
      payoutProviderIntegrationVerified: true,
      atomicConfirmer: new DrizzleAtomicPayoutConfirmer(),
      atomicReturner: new DrizzleAtomicPayoutReturner(),
      ...overrides,
    });
  }

  return { payments, ledger, payoutAttempts, buildPayoutService };
}

async function seedClearedPaymentWithPendingPayout(
  ctx: ReturnType<typeof buildContext>,
  opts: { agreementId: string; amountMinorUnits: number; payerProfileId: string; recipientProfileId: string },
) {
  const payment = await ctx.payments.insertPending({
    idempotencyKey: randomUUID(),
    payerProfileKind: "personal",
    payerProfileId: opts.payerProfileId,
    recipientProfileKind: "personal",
    recipientProfileId: opts.recipientProfileId,
    amountMinorUnits: opts.amountMinorUnits,
    currency: "USD",
    agreementId: opts.agreementId,
    providerName: "sandbox_mock",
    initialStatus: "succeeded",
  });
  await ctx.ledger.postPaymentCleared({
    paymentAttemptId: payment.id,
    agreementId: opts.agreementId,
    currency: "USD",
    grossAmountMinorUnits: opts.amountMinorUnits,
  });
  await ctx.payoutAttempts.insert({ paymentAttemptId: payment.id, agreementId: opts.agreementId });
  return payment;
}

async function creditorLiability(ctx: ReturnType<typeof buildContext>, paymentAttemptId: string) {
  const entries = await ctx.ledger.listEntriesForPaymentAttempt(paymentAttemptId);
  return entries
    .flatMap((e) => e.postings)
    .filter((p) => p.accountType === "creditor_proceeds_payable")
    .reduce((sum, p) => sum + (p.direction === "credit" ? p.amountMinorUnits : -p.amountMinorUnits), 0);
}

describe("PayoutService atomic confirm/return (PAID2YOU — B0-D PHASE 3B, real Postgres — G4)", () => {
  it("successful confirmation: posts the payout ledger entry, marks payout_attempt confirmed, and sets payment_attempt.payoutCompletedAt — all three durably true after commit", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const payment = await seedClearedPaymentWithPendingPayout(ctx, { agreementId, amountMinorUnits: 5_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId });
    const payoutService = ctx.buildPayoutService();

    const confirmed = await payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "psp_pg_1" });

    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.providerPayoutReference).toBe("psp_pg_1");
    const reloadedAttempt = await ctx.payoutAttempts.findByPaymentAttemptId(payment.id);
    expect(reloadedAttempt?.status).toBe("confirmed");
    const reloadedPayment = await ctx.payments.findById(payment.id);
    expect(reloadedPayment?.payoutCompletedAt).not.toBeNull();
    const payoutEntries = (await ctx.ledger.listEntriesForPaymentAttempt(payment.id)).filter((e) => e.entryType === "payout");
    expect(payoutEntries).toHaveLength(1);
    expect(await creditorLiability(ctx, payment.id)).toBe(0);
  });

  it("concurrent confirmation: two independent real Postgres connections confirming the SAME payout produce exactly one financial effect — one payout ledger entry, one set of provider evidence, payoutCompletedAt set exactly once", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { creditor, debtor, agreementId } = await seedTwoParties();
      const ctx = buildContext();
      const payment = await seedClearedPaymentWithPendingPayout(ctx, { agreementId, amountMinorUnits: 1_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId });

      const isolatedA = createIsolatedDb(DATABASE_URL);
      const isolatedB = createIsolatedDb(DATABASE_URL);
      try {
        const payoutServiceA = ctx.buildPayoutService({ atomicConfirmer: new DrizzleAtomicPayoutConfirmer(isolatedA.db) });
        const payoutServiceB = ctx.buildPayoutService({ atomicConfirmer: new DrizzleAtomicPayoutConfirmer(isolatedB.db) });

        const [resultA, resultB] = await Promise.all([
          payoutServiceA.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: `psp_race_${attempt}` }),
          payoutServiceB.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: `psp_race_${attempt}` }),
        ]);

        expect(resultA.status).toBe("confirmed");
        expect(resultB.status).toBe("confirmed");
        // Both calls observe the SAME confirmedAt — one of them actually wrote it, the other raced
        // past the lock and re-read the already-committed row, never re-executed the ledger/mark logic.
        expect(resultA.confirmedAt?.getTime()).toBe(resultB.confirmedAt?.getTime());

        const payoutEntries = (await ctx.ledger.listEntriesForPaymentAttempt(payment.id)).filter((e) => e.entryType === "payout");
        expect(payoutEntries).toHaveLength(1); // never duplicated by the race.
        const reloadedPayment = await ctx.payments.findById(payment.id);
        expect(reloadedPayment?.payoutCompletedAt).not.toBeNull();
      } finally {
        await isolatedA.close();
        await isolatedB.close();
      }
    }
  });

  it("failure and rollback: a forced error immediately after the ledger entry is posted (still inside the transaction) rolls back the ledger entry too — no orphaned ledger row, payout_attempt still pending, payoutCompletedAt still null", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const payment = await seedClearedPaymentWithPendingPayout(ctx, { agreementId, amountMinorUnits: 2_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId });

    const failingConfirmer = new DrizzleAtomicPayoutConfirmer(getDb(), {
      afterLedgerPost: async () => {
        throw new Error("simulated_crash_after_ledger_post");
      },
    });
    const payoutService = ctx.buildPayoutService({ atomicConfirmer: failingConfirmer });

    await expect(payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "psp_crash_1" })).rejects.toThrow(
      "simulated_crash_after_ledger_post",
    );

    const payoutEntries = (await ctx.ledger.listEntriesForPaymentAttempt(payment.id)).filter((e) => e.entryType === "payout");
    expect(payoutEntries).toHaveLength(0); // the ledger insert rolled back with everything else.
    const reloadedAttempt = await ctx.payoutAttempts.findByPaymentAttemptId(payment.id);
    expect(reloadedAttempt?.status).toBe("pending"); // never reached "confirmed".
    const reloadedPayment = await ctx.payments.findById(payment.id);
    expect(reloadedPayment?.payoutCompletedAt).toBeNull(); // never set.
    expect(await creditorLiability(ctx, payment.id)).toBe(2_000); // liability untouched — no contradictory state.

    // A genuine retry (no injected failure this time) now succeeds cleanly from the same "pending" state.
    const retried = await ctx.buildPayoutService().confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "psp_crash_1_retry" });
    expect(retried.status).toBe("confirmed");
  });

  it("failure and rollback: a forced error immediately after payout_attempt is marked confirmed (still inside the transaction) rolls back BOTH the mark AND the ledger entry together", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const payment = await seedClearedPaymentWithPendingPayout(ctx, { agreementId, amountMinorUnits: 3_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId });

    const failingConfirmer = new DrizzleAtomicPayoutConfirmer(getDb(), {
      afterAttemptMarked: async () => {
        throw new Error("simulated_crash_after_attempt_marked");
      },
    });
    const payoutService = ctx.buildPayoutService({ atomicConfirmer: failingConfirmer });

    await expect(payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "psp_crash_2" })).rejects.toThrow(
      "simulated_crash_after_attempt_marked",
    );

    const payoutEntries = (await ctx.ledger.listEntriesForPaymentAttempt(payment.id)).filter((e) => e.entryType === "payout");
    expect(payoutEntries).toHaveLength(0); // rolled back together with the status mark — no orphaned ledger row.
    const reloadedAttempt = await ctx.payoutAttempts.findByPaymentAttemptId(payment.id);
    expect(reloadedAttempt?.status).toBe("pending"); // the mark rolled back too — no contradictory "confirmed" with no ledger evidence.
    const reloadedPayment = await ctx.payments.findById(payment.id);
    expect(reloadedPayment?.payoutCompletedAt).toBeNull();
  });

  it("successful return: reinstates the creditor's liability exactly once, marks payout_attempt returned, and clears payment_attempt.payoutCompletedAt", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const payment = await seedClearedPaymentWithPendingPayout(ctx, { agreementId, amountMinorUnits: 4_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId });
    const payoutService = ctx.buildPayoutService();
    await payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "psp_return_1" });
    expect(await creditorLiability(ctx, payment.id)).toBe(0);
    expect((await ctx.payments.findById(payment.id))?.payoutCompletedAt).not.toBeNull();

    const returned = await payoutService.returnPayout({ paymentAttemptId: payment.id, reason: "bank returned the transfer" });

    expect(returned.status).toBe("returned");
    // Original confirmation history preserved alongside the new return fields.
    expect(returned.confirmedAt).not.toBeNull();
    expect(returned.providerPayoutReference).toBe("psp_return_1");
    expect(await creditorLiability(ctx, payment.id)).toBe(4_000); // liability reinstated exactly once.
    const returnEntries = (await ctx.ledger.listEntriesForPaymentAttempt(payment.id)).filter((e) => e.entryType === "payout_returned");
    expect(returnEntries).toHaveLength(1);
    const reloadedPayment = await ctx.payments.findById(payment.id);
    expect(reloadedPayment?.payoutCompletedAt).toBeNull(); // G3 correction — cleared, not left stale.
  });

  it("concurrent AND duplicate returns: two independent connections returning the SAME confirmed payout, plus a subsequent duplicate call, all converge on exactly one ledger correction and one liability reinstatement", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const payment = await seedClearedPaymentWithPendingPayout(ctx, { agreementId, amountMinorUnits: 1_500, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId });
    await ctx.buildPayoutService().confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "psp_dup_return" });

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const payoutServiceA = ctx.buildPayoutService({ atomicReturner: new DrizzleAtomicPayoutReturner(isolatedA.db) });
      const payoutServiceB = ctx.buildPayoutService({ atomicReturner: new DrizzleAtomicPayoutReturner(isolatedB.db) });

      const [resultA, resultB] = await Promise.all([
        payoutServiceA.returnPayout({ paymentAttemptId: payment.id, reason: "concurrent return A" }),
        payoutServiceB.returnPayout({ paymentAttemptId: payment.id, reason: "concurrent return B" }),
      ]);
      expect(resultA.status).toBe("returned");
      expect(resultB.status).toBe("returned");
      expect(resultA.returnedAt?.getTime()).toBe(resultB.returnedAt?.getTime());

      // A subsequent, sequential duplicate call must ALSO be a no-op.
      const duplicate = await ctx.buildPayoutService().returnPayout({ paymentAttemptId: payment.id, reason: "duplicate, after both raced calls already committed" });
      expect(duplicate.returnedAt?.getTime()).toBe(resultA.returnedAt?.getTime());

      const returnEntries = (await ctx.ledger.listEntriesForPaymentAttempt(payment.id)).filter((e) => e.entryType === "payout_returned");
      expect(returnEntries).toHaveLength(1); // never duplicated by the race or the later duplicate call.
      expect(await creditorLiability(ctx, payment.id)).toBe(1_500); // reinstated exactly once.
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("failure and rollback on return: a forced error immediately after the reversing ledger entry is posted rolls back the ledger entry too — payout_attempt still confirmed, payoutCompletedAt still set, no contradictory state", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    const payment = await seedClearedPaymentWithPendingPayout(ctx, { agreementId, amountMinorUnits: 2_500, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId });
    await ctx.buildPayoutService().confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "psp_return_crash" });

    const failingReturner = new DrizzleAtomicPayoutReturner(getDb(), {
      afterLedgerCorrection: async () => {
        throw new Error("simulated_crash_after_return_ledger_post");
      },
    });
    const payoutService = ctx.buildPayoutService({ atomicReturner: failingReturner });

    await expect(payoutService.returnPayout({ paymentAttemptId: payment.id, reason: "will fail mid-transaction" })).rejects.toThrow("simulated_crash_after_return_ledger_post");

    const returnEntries = (await ctx.ledger.listEntriesForPaymentAttempt(payment.id)).filter((e) => e.entryType === "payout_returned");
    expect(returnEntries).toHaveLength(0); // rolled back.
    const reloadedAttempt = await ctx.payoutAttempts.findByPaymentAttemptId(payment.id);
    expect(reloadedAttempt?.status).toBe("confirmed"); // never reached "returned" — no contradictory status.
    const reloadedPayment = await ctx.payments.findById(payment.id);
    expect(reloadedPayment?.payoutCompletedAt).not.toBeNull(); // never cleared — no contradictory completion timestamp.
    expect(await creditorLiability(ctx, payment.id)).toBe(0); // still paid out, as it genuinely still is.
  });

  it("cannot confirm a payout that has never cleared — the atomic confirmer's own ledger validation, exercised against real Postgres", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const ctx = buildContext();
    // Insert the payout_attempt row directly, WITHOUT ever posting a payment_cleared ledger entry —
    // an inconsistent state this atomic confirmer must reject rather than paper over.
    const payment = await ctx.payments.insertPending({
      idempotencyKey: randomUUID(),
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 1_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox_mock",
      initialStatus: "succeeded",
    });
    await ctx.payoutAttempts.insert({ paymentAttemptId: payment.id, agreementId });
    const payoutService = ctx.buildPayoutService();

    await expect(payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "psp_no_clear" })).rejects.toThrow(ValidationError);
    const reloadedAttempt = await ctx.payoutAttempts.findByPaymentAttemptId(payment.id);
    expect(reloadedAttempt?.status).toBe("pending");
  });
});
