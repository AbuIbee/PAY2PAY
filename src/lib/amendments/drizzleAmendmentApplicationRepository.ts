import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, agreementVersion, amendment, installmentScheduleItem } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { AgreementTerms, FeeAllocation } from "@/lib/agreements/agreementService";
import type { PaymentFrequency } from "@/lib/agreements/schedule";
import type { AmendmentApplicationRepository, AmendmentRecord } from "./amendmentService";

type AmendmentRow = typeof amendment.$inferSelect;

function toAmendmentRecord(row: AmendmentRow): AmendmentRecord {
  return {
    id: row.id,
    agreementId: row.agreementId,
    changeType: row.changeType,
    status: row.status,
    proposingPartyRole: row.proposingPartyRole,
    proposedByProfileKind: row.proposedByProfileKind,
    proposedByProfileId: row.proposedByProfileId,
    reason: row.reason,
    requestedRelief: row.requestedRelief,
    proposedEffectiveDate: row.proposedEffectiveDate,
    frequency: row.frequency,
    feeAllocation: row.feeAllocation,
    terms: row.terms as AgreementTerms,
    creditorSignedAt: row.creditorSignedAt,
    debtorSignedAt: row.debtorSignedAt,
    signedAt: row.signedAt,
    resultingVersionId: row.resultingVersionId,
    rejectedReason: row.rejectedReason,
    rejectedAt: row.rejectedAt,
    withdrawnReason: row.withdrawnReason,
    withdrawnAt: row.withdrawnAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * PRSprint 11 (docs/prsprints/PRSPRINT_11_AGREEMENT_VERSIONING_AMENDMENTS_MUTUAL_APPROVAL.md): see
 * AmendmentApplicationRepository's own doc comment in amendmentService.ts for why this exists as a
 * single, hand-written multi-table transaction rather than four separate repository calls. Writes
 * directly against the raw Drizzle table objects (not through
 * DrizzleAgreementVersionRepository/DrizzleInstallmentScheduleItemRepository/
 * DrizzleAgreementRepository/DrizzleAmendmentRepository) specifically so every statement below
 * shares the same `tx` and therefore the same commit/rollback unit — those four repositories'
 * existing methods each open their own `getDb()` connection and are deliberately left untouched
 * (still correct, still tested, still used by every non-amendment caller: initial agreement
 * creation, plain signing, reads).
 */
export class DrizzleAmendmentApplicationRepository implements AmendmentApplicationRepository {
  async applyAtomically(input: {
    agreementId: string;
    amendmentId: string;
    versionNumber: number;
    parentVersionId: string;
    frequency: PaymentFrequency;
    feeAllocation: FeeAllocation;
    terms: AgreementTerms;
    scheduleItems: { sequenceNumber: number; dueDate: string; amountMinorUnits: number }[];
    creditorSignedAt: Date | null;
    debtorSignedAt: Date | null;
    documentHash: string;
    signedAt: Date;
    pauseAgreement: boolean;
  }): Promise<{ agreementVersionId: string; amendment: AmendmentRecord }> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [versionRow] = await tx
        .insert(agreementVersion)
        .values({
          agreementId: input.agreementId,
          versionNumber: input.versionNumber,
          parentVersionId: input.parentVersionId,
          isOriginal: false,
          producedBy: "amendment",
          frequency: input.frequency,
          feeAllocation: input.feeAllocation,
          terms: input.terms as object,
          creditorSignedAt: input.creditorSignedAt,
          debtorSignedAt: input.debtorSignedAt,
          documentHash: input.documentHash,
          signedAt: input.signedAt,
        })
        .returning();
      if (!versionRow) throw new ConfigurationError("agreement_version insert returned no row");

      if (input.scheduleItems.length > 0) {
        await tx.insert(installmentScheduleItem).values(
          input.scheduleItems.map((item) => ({
            agreementVersionId: versionRow.id,
            sequenceNumber: item.sequenceNumber,
            dueDate: item.dueDate,
            amountMinorUnits: item.amountMinorUnits,
          })),
        );
      }

      await tx
        .update(agreement)
        .set({
          currentVersionId: versionRow.id,
          ...(input.pauseAgreement ? { status: "paused_by_amendment" as const } : {}),
        })
        .where(eq(agreement.id, input.agreementId));

      const [amendmentRow] = await tx
        .update(amendment)
        .set({ status: "applied", resultingVersionId: versionRow.id, updatedAt: new Date() })
        .where(eq(amendment.id, input.amendmentId))
        .returning();
      if (!amendmentRow) throw new ConfigurationError("amendment update returned no row during atomic apply");

      return { agreementVersionId: versionRow.id, amendment: toAmendmentRecord(amendmentRow) };
    });
  }
}
