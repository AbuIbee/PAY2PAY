import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { agreement, agreementVersion, paymentAttempt } from "@/db/schema";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { DrizzleLedgerAccountRepository } from "@/lib/ledger/drizzleLedgerAccountRepository";
import { DrizzleLedgerJournalEntryRepository } from "@/lib/ledger/drizzleLedgerJournalEntryRepository";
import { DrizzleReconciliationExceptionRepository } from "@/lib/ledger/drizzleReconciliationExceptionRepository";
import { LedgerService } from "@/lib/ledger/ledgerService";
import { ReconciliationService } from "@/lib/ledger/reconciliationService";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { DrizzlePaymentWebhookEventRepository } from "@/lib/payments/drizzlePaymentWebhookEventRepository";
import { SandboxPaymentProvider } from "@/test-support/payments/sandboxPaymentProvider";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { createIsolatedDb, warmUp } from "../../../test/postgres/testDb";

/**
 * Stage 4 — Section 9 (minimum reconciliation real-PostgreSQL proof). REC-01 is the required
 * representative drift-detection proof. REC-02 exists ONLY because direct code inspection of
 * `ReconciliationService.recordException` (`reconciliationService.ts:700-709`) and the
 * `reconciliation_exception` schema (`src/db/schema/ledger.ts:98-138`) showed a realistically
 * reachable duplicate-open-exception race: `recordException` uses a plain `findOpen()`-then-`insert()`
 * sequence, and the table's own `reconciliation_exception_open_identity_unique` partial unique index
 * cannot protect any exception type whose `providerEventId` is `null` (SQL NULL is never equal to
 * NULL, so the index is a structural no-op there) — and the majority of `recordException` call sites
 * (`missing_provider_transaction`, `status_mismatch`, `stale_pending_settlement`,
 * `reversal_refund_mismatch`, `duplicate_transaction`, `internal_posting_failure`) pass exactly that
 * shape. This is not a theoretical race — it is demonstrated below.
 */

const WEBHOOK_SECRET = "stage4-reconciliation-postgres-test-webhook-secret";
const DATABASE_URL = process.env.DATABASE_URL!;

async function seedAgreement(creditorProfileId: string, debtorProfileId: string, creatorUserId: string, principalMinorUnits: number): Promise<string> {
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
      producedBy: "stage4_reconciliation_postgres_test_seed",
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
  const creditor = await seedPersonalUser("s4-rec-creditor");
  const debtor = await seedPersonalUser("s4-rec-debtor");
  const agreementId = await seedAgreement(creditor.profileId, debtor.profileId, creditor.userId, principalMinorUnits);
  return { creditor, debtor, agreementId };
}

/** Seeds a real payment attempt that is durably "succeeded" but has NO providerPaymentId — the exact `missing_provider_transaction` drift condition `reconcilePaymentAttempt` detects (`reconciliationService.ts:229-230`). */
async function seedDriftedPayment(agreementId: string, debtor: { profileId: string }, creditor: { profileId: string }): Promise<{ id: string }> {
  const payments = new DrizzlePaymentAttemptRepository();
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
  });
  const db = getDb();
  // Directly forced to "succeeded" with providerPaymentId left null — models a real drift condition
  // (e.g. a local status write that raced ahead of the provider-reference write), not something the
  // normal application code path would itself produce end-to-end.
  await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, inserted.id));
  return { id: inserted.id };
}

function buildReconciliationService(exceptions: DrizzleReconciliationExceptionRepository): ReconciliationService {
  return new ReconciliationService({
    payments: new DrizzlePaymentAttemptRepository(),
    webhookEvents: new DrizzlePaymentWebhookEventRepository(),
    provider: new SandboxPaymentProvider(WEBHOOK_SECRET),
    ledger: new LedgerService({ accounts: new DrizzleLedgerAccountRepository(), entries: new DrizzleLedgerJournalEntryRepository(), audit: new AuditService(new DrizzleAuditEventRepository()) }),
    exceptions,
  });
}

describe("Stage 4: reconciliation real-PostgreSQL proof", () => {
  it("REC-01 — a genuine persisted drift (succeeded payment with no provider reference) produces exactly the expected open reconciliation exception, with correct linkage, and no silent financial mutation", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const payment = await seedDriftedPayment(agreementId, debtor, creditor);
    const reconciliation = buildReconciliationService(new DrizzleReconciliationExceptionRepository());

    const found = await reconciliation.reconcilePaymentAttempt(payment.id);
    const missing = found.filter((e) => e.exceptionType === "missing_provider_transaction");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.paymentAttemptId).toBe(payment.id);
    expect(missing[0]?.status).toBe("open");
    expect((missing[0]?.details as { status?: string } | null)?.status).toBe("succeeded"); // observed state recorded correctly.

    // No silent financial mutation: the payment's own status is untouched by reconciliation.
    const db = getDb();
    const paymentRow = (await db.select().from(paymentAttempt).where(eq(paymentAttempt.id, payment.id)))[0];
    expect(paymentRow?.status).toBe("succeeded");

    // Idempotent re-run: exactly one open exception remains, never a second one.
    const secondRun = await reconciliation.reconcilePaymentAttempt(payment.id);
    expect(secondRun.filter((e) => e.exceptionType === "missing_provider_transaction")).toHaveLength(1);
    const allOpen = await reconciliation.listExceptionsForPaymentAttempt(payment.id);
    expect(allOpen.filter((e) => e.exceptionType === "missing_provider_transaction" && e.status === "open")).toHaveLength(1);
  });

  it("REC-02 — two genuinely concurrent reconciliation runs detecting the identical drift produce exactly one open exception, not two", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const payment = await seedDriftedPayment(agreementId, debtor, creditor);

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      await warmUp(isolatedA.client);
      await warmUp(isolatedB.client);
      const reconciliationA = buildReconciliationService(new DrizzleReconciliationExceptionRepository(isolatedA.db));
      const reconciliationB = buildReconciliationService(new DrizzleReconciliationExceptionRepository(isolatedB.db));

      await Promise.all([reconciliationA.reconcilePaymentAttempt(payment.id), reconciliationB.reconcilePaymentAttempt(payment.id)]);

      const exceptions = await new DrizzleReconciliationExceptionRepository().listForPaymentAttempt(payment.id);
      const openMissing = exceptions.filter((e) => e.exceptionType === "missing_provider_transaction" && e.status === "open");
      expect(openMissing).toHaveLength(1); // exactly one — the duplicate-open-exception race is closed.
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });
});
