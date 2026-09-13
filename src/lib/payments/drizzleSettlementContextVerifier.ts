import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { settlementProposal } from "@/db/schema";
import type { SettlementContextVerifier } from "./paymentService";

/**
 * R11 (Final Open Issue A — SETTLEMENT EXEMPTION): real implementation of
 * `SettlementContextVerifier` — see that interface's own doc comment in paymentService.ts. Verifies a
 * caller-supplied `settlementProposalId` against real, current `settlement_proposal` state — never
 * merely trusts the caller's own claim that "this is a settlement payment." A formal settlement
 * payment is, by `SettlementService`'s own design, never tied to one specific installment (see
 * `SettlementService.recordSettlementPayment`'s own doc comment) — this is the ONLY sanctioned way an
 * ordinary payment-creation path may be exempted from the R11 linkage requirement.
 */
export class DrizzleSettlementContextVerifier implements SettlementContextVerifier {
  async isAwaitingPaymentForAgreement(settlementProposalId: string, agreementId: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .select({ id: settlementProposal.id })
      .from(settlementProposal)
      .where(and(eq(settlementProposal.id, settlementProposalId), eq(settlementProposal.agreementId, agreementId), eq(settlementProposal.status, "awaiting_payment")))
      .limit(1);
    return rows.length > 0;
  }
}
