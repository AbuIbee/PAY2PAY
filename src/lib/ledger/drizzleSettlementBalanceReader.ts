import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { settlementProposal } from "@/db/schema";
import type { SettlementBalanceReader, SettlementBalanceResolution } from "./balanceService";

/**
 * Stage 4 settlement-balance remediation (corrected pass): reads directly from the same
 * `settlement_proposal` table `DrizzleSettlementRepository` (Sprint 15) already writes — never a
 * second, duplicated settlement source of truth. No new schema.
 *
 * PRECEDENCE (see `SettlementBalanceResolution`'s own doc comment in balanceService.ts):
 * 1. If ANY settlement proposal for this agreement is `completed`, its own `forgivenAmountMinorUnits`
 *    values are summed (mirrors `reconstructPaidAndReversed`'s own "sum rather than assume
 *    uniqueness" precedent) and returned as `"forgiveness"` — a completed settlement always takes
 *    precedence, since it represents the fully-realized negotiated outcome.
 * 2. Otherwise, the MOST RECENT `failure_consequence_applied` proposal (by `createdAt`, matching
 *    `DrizzleSettlementRepository.listForAgreement`'s own descending order) is consulted — only its
 *    own persisted `resolvedConsequence` governs, never every failed row treated the same way:
 *    - `forgive_permanently` -> `"forgiveness"` using `resolvedForgivenAmountMinorUnits`.
 *    - `restore_stated` -> `"restoredBalance"` using `resolvedRestoredBalanceMinorUnits`.
 *    - `restore_original`/`prior_agreement_controls` -> `"none"` (the ordinary ledger-only
 *      calculation is already correct for these: `restore_original`'s own persisted rule,
 *      `preSettlementBalance - totalCollected`, is mathematically identical to `principal -
 *      amountPaidMinorUnits` with zero forgiveness, since `preSettlementBalance` was itself
 *      `principal - amountPaid` at proposal time and `totalCollected` is additional real cash
 *      already reflected in `amountPaidMinorUnits`; `prior_agreement_controls` is declarative-only
 *      by design, per `settlementService.ts`'s own `resolveFailureConsequence`).
 * 3. No settlement at all, or only `proposed`/`awaiting_payment`/`rejected` proposals -> `"none"`.
 *
 * Only one settlement's consequence is ever applied — never counted twice.
 */
export class DrizzleSettlementBalanceReader implements SettlementBalanceReader {
  async getSettlementBalanceResolution(agreementId: string): Promise<SettlementBalanceResolution> {
    const db = getDb();
    const rows = await db.select().from(settlementProposal).where(eq(settlementProposal.agreementId, agreementId)).orderBy(desc(settlementProposal.createdAt));

    const completedForgiveness = rows.filter((r) => r.status === "completed").reduce((sum, r) => sum + r.forgivenAmountMinorUnits, 0);
    if (completedForgiveness > 0) {
      return { kind: "forgiveness", effectiveForgivenMinorUnits: completedForgiveness };
    }

    const mostRecentFailed = rows.find((r) => r.status === "failure_consequence_applied");
    if (!mostRecentFailed) return { kind: "none" };

    if (mostRecentFailed.resolvedConsequence === "forgive_permanently" && mostRecentFailed.resolvedForgivenAmountMinorUnits != null) {
      return { kind: "forgiveness", effectiveForgivenMinorUnits: mostRecentFailed.resolvedForgivenAmountMinorUnits };
    }
    if (mostRecentFailed.resolvedConsequence === "restore_stated" && mostRecentFailed.resolvedRestoredBalanceMinorUnits != null) {
      return { kind: "restoredBalance", restoredRemainingBalanceMinorUnits: mostRecentFailed.resolvedRestoredBalanceMinorUnits };
    }
    // restore_original / prior_agreement_controls, or a resolved* field unexpectedly null — the
    // ordinary ledger-only calculation already governs (see this class's own doc comment, point 2).
    return { kind: "none" };
  }
}
