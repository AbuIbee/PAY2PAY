import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { agreement, agreementVersion } from "@/db/schema";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { AgreementCompletionService, type AgreementBalanceComputer, type AgreementStatusRepository } from "@/lib/ledger/agreementCompletionService";
import { BalanceService } from "@/lib/ledger/balanceService";
import { DrizzleAgreementTermsReader } from "@/lib/ledger/drizzleAgreementTermsReader";
import { DrizzleLedgerAccountRepository } from "@/lib/ledger/drizzleLedgerAccountRepository";
import { DrizzleLedgerJournalEntryRepository } from "@/lib/ledger/drizzleLedgerJournalEntryRepository";
import { DrizzleReconciliationExceptionRepository } from "@/lib/ledger/drizzleReconciliationExceptionRepository";
import { LedgerService } from "@/lib/ledger/ledgerService";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { DrizzlePaymentAttemptRepository } from "./drizzlePaymentAttemptRepository";
import { DrizzlePaymentWebhookEventRepository } from "./drizzlePaymentWebhookEventRepository";
import type { PaymentAttemptRecord } from "./paymentService";
import { DrizzlePaymentTransitionCoordinator } from "./paymentTransitionCoordinator";
import { PaymentWebhookService } from "./paymentWebhookService";
import { SandboxPaymentProvider } from "@/test-support/payments/sandboxPaymentProvider";

/**
 * Stage 4 — Section 7 (minimum corrective-event accounting proof, real PostgreSQL). COR-01/COR-02
 * only, per the governing order's own "do not execute the previously proposed exhaustive C-J matrix"
 * instruction — refund is used as the one representative corrective status; `reversal`/`dispute_
 * adjustment` share the identical `LedgerService.reversePayment` branch and
 * `PaymentWebhookService.applyEvent` dispatch, so this is genuinely representative, not a narrowed
 * subset of a materially different code path.
 */

const WEBHOOK_SECRET = "stage4-corrective-event-postgres-test-webhook-secret";

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
      producedBy: "stage4_corrective_event_postgres_test_seed",
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
  const ledger = new LedgerService({ accounts: new DrizzleLedgerAccountRepository(), entries: new DrizzleLedgerJournalEntryRepository(), audit: new AuditService(new DrizzleAuditEventRepository()) });
  const agreements = new DrizzleAgreementRepository();
  const balances = new BalanceService({ ledger, terms: new DrizzleAgreementTermsReader() });
  const completion = new AgreementCompletionService({
    agreements: agreements as unknown as AgreementStatusRepository,
    balances: balances as unknown as AgreementBalanceComputer,
    audit: new AuditService(new DrizzleAuditEventRepository()),
  });
  const exceptions = new DrizzleReconciliationExceptionRepository();
  const webhook = new PaymentWebhookService({
    provider,
    events,
    payments,
    transitionCoordinator: new DrizzlePaymentTransitionCoordinator(),
    ledger,
    audit: new AuditService(new DrizzleAuditEventRepository()),
    completion,
    conflictExceptions: exceptions,
  });
  return { provider, payments, events, ledger, agreements, balances, webhook };
}

function signedWebhook(provider: SandboxPaymentProvider, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return { rawBody, signatureHeader: provider.signWebhookPayload(rawBody) };
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

async function seedTwoParties(principalMinorUnits = 10_000) {
  const creditor = await seedPersonalUser("s4-cor-creditor");
  const debtor = await seedPersonalUser("s4-cor-debtor");
  const agreementId = await seedAgreement(creditor.profileId, debtor.profileId, creditor.userId, principalMinorUnits);
  return { creditor, debtor, agreementId };
}

describe("Stage 4: minimum corrective-event accounting proof (real Postgres)", () => {
  it("COR-01 — a cleared payment, then refunded: no longer counts as economically paid, a corrective ledger entry exists, balance is restored correctly, and history is preserved", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 5_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });

    const succeeded = await ctx.webhook.receiveWebhook(
      signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }),
    );
    expect(succeeded.status).toBe("processed");
    const balanceAfterSuccess = await ctx.balances.getAgreementBalance(agreementId);
    expect(balanceAfterSuccess.amountPaidMinorUnits).toBe(5_000);
    expect(balanceAfterSuccess.settlementState).toBe("paid_in_full");

    const refunded = await ctx.webhook.receiveWebhook(
      signedWebhook(ctx.provider, { providerEventId: `evt-${randomUUID()}`, eventType: "payment.refunded", providerPaymentId }),
    );
    expect(refunded.status).toBe("processed");

    // No longer counts as economically paid.
    const balanceAfterRefund = await ctx.balances.getAgreementBalance(agreementId);
    expect(balanceAfterRefund.amountPaidMinorUnits).toBe(0);
    expect(balanceAfterRefund.reversedMinorUnits).toBe(5_000);
    expect(balanceAfterRefund.remainingBalanceMinorUnits).toBe(5_000); // restored correctly — not left falsely at 0.
    expect(balanceAfterRefund.settlementState).toBe("unpaid");

    // Corrective ledger entry exists; history is preserved (the original payment_cleared entry is
    // never deleted or rewritten — see LedgerService's own append-only design).
    const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
    expect(entries.filter((e) => e.entryType === "refund")).toHaveLength(1);
    expect((await ctx.payments.findById(payment.id))?.status).toBe("refunded");
  });

  it("COR-02 — a refund is already authoritative, then a delayed/duplicate success is processed: the stale success does not recreate the paid effect, no duplicate ledger entry, and the final balance remains authoritative", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties(5_000);
    const ctx = buildContext();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const payment = await seedPendingPayment(ctx.payments, { agreementId, amountMinorUnits: 5_000, payerProfileId: debtor.profileId, recipientProfileId: creditor.profileId, providerPaymentId });

    const succeeded = await ctx.webhook.receiveWebhook(
      signedWebhook(ctx.provider, { providerEventId: `evt-succ-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }),
    );
    expect(succeeded.status).toBe("processed");
    const refunded = await ctx.webhook.receiveWebhook(
      signedWebhook(ctx.provider, { providerEventId: `evt-ref-${randomUUID()}`, eventType: "payment.refunded", providerPaymentId }),
    );
    expect(refunded.status).toBe("processed");
    const authoritativeBalance = await ctx.balances.getAgreementBalance(agreementId);
    expect(authoritativeBalance.amountPaidMinorUnits).toBe(0);

    // A delayed/duplicate success for the SAME provider payment, delivered as a genuinely new event
    // (a distinct providerEventId — modeling a redelivered/out-of-order webhook, not a literal
    // duplicate of an already-processed event id).
    const staleSuccess = await ctx.webhook.receiveWebhook(
      signedWebhook(ctx.provider, { providerEventId: `evt-stale-succ-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId }),
    );
    // The event itself is still durably recorded as processed (a terminal, non-erroring outcome —
    // never left claimed-but-unresolved) — but its content is recognized as stale against the
    // already-refunded status and safely ignored, never reapplied. This is proven by the assertions
    // below (financial state unchanged), not by the event's own processing-pipeline status.
    expect(staleSuccess.status).toBe("processed");

    const finalBalance = await ctx.balances.getAgreementBalance(agreementId);
    expect(finalBalance.amountPaidMinorUnits).toBe(0); // stale success did not recreate the paid effect.
    expect(finalBalance.reversedMinorUnits).toBe(5_000);
    expect(finalBalance.remainingBalanceMinorUnits).toBe(5_000); // final balance remains authoritative.

    const entries = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // no duplicate.
    expect(entries.filter((e) => e.entryType === "refund")).toHaveLength(1);
    expect((await ctx.payments.findById(payment.id))?.status).toBe("refunded"); // not reverted to succeeded.
  });
});
