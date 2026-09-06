import "server-only";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { agreement, agreementVersion, installmentScheduleItem } from "@/db/schema";
import { ConfigurationError, ConflictError } from "@/lib/errors";
import type { RevisionApplicationRepository, RevisionApplicationResult } from "./agreementService";
import type { AgreementLockTestHooks } from "./drizzleSigningApplicationRepository";

/**
 * R07 corrective pass (Codex finding G): see `RevisionApplicationRepository`'s own doc comment in
 * agreementService.ts for the full race this closes and why the lock order below must match
 * `DrizzleSigningApplicationRepository` exactly. Writes directly against the raw Drizzle table
 * objects (not through `DrizzleAgreementVersionRepository`/`DrizzleAgreementRepository`/
 * `DrizzleInstallmentScheduleItemRepository`) for the identical reason that class does: every
 * statement below must share the same `tx`, and therefore the same commit/rollback unit.
 */
export class DrizzleRevisionApplicationRepository implements RevisionApplicationRepository {
  /**
   * R07 corrective pass: `db` is injectable (defaulting to the shared production singleton) solely
   * so `*.postgres.test.ts` concurrency suites can pair this class with
   * `DrizzleSigningApplicationRepository` on two genuinely distinct PostgreSQL connections, proving
   * real overlap/contention. Every production call site (`new DrizzleRevisionApplicationRepository()`,
   * no argument) is unaffected. `hooks` is the same test-only affordance
   * `DrizzleSigningApplicationRepository` accepts — see `AgreementLockTestHooks`'s own doc comment.
   */
  constructor(
    private readonly db: Database = getDb(),
    private readonly hooks?: AgreementLockTestHooks,
  ) {}

  async applyFirstPaymentDateRevisionAtomically(
    input: Parameters<RevisionApplicationRepository["applyFirstPaymentDateRevisionAtomically"]>[0],
  ): Promise<RevisionApplicationResult> {
    const db = this.db;
    return db.transaction(async (tx) => {
      if (this.hooks?.beforeAgreementLock) await this.hooks.beforeAgreementLock();
      // Lock order (agreement, then its current version) — MUST match
      // DrizzleSigningApplicationRepository's identical ordering exactly; that shared ordering is
      // what makes signing and revision mutually exclusive at the database level (see this class's
      // own doc comment, and that class's).
      const agreementRows = await tx.select().from(agreement).where(eq(agreement.id, input.agreementId)).for("update").limit(1);
      if (this.hooks?.afterAgreementLock) await this.hooks.afterAgreementLock();
      const agreementRow = agreementRows[0];
      if (!agreementRow) throw new ConfigurationError("agreement not found during atomic revision apply");
      if (agreementRow.status !== "awaiting_signatures") {
        throw new ConflictError(
          `This agreement is no longer awaiting signatures (it is now "${agreementRow.status}") — its schedule can no longer be revised this way. Please refresh and try again.`,
        );
      }
      if (agreementRow.currentVersionId !== input.baseVersionId) {
        throw new ConflictError(
          "This agreement's terms were already revised by another request. Please refresh and try again.",
        );
      }

      const versionRows = await tx.select().from(agreementVersion).where(eq(agreementVersion.id, input.baseVersionId)).for("update").limit(1);
      const versionRow = versionRows[0];
      if (!versionRow) throw new ConfigurationError("agreement_version not found during atomic revision apply");
      if (versionRow.agreementId !== input.agreementId) {
        throw new ConflictError("This version does not belong to the specified agreement — refusing to revise.");
      }
      // The core race this whole class exists to close: a concurrent signing transaction may have
      // committed (`versionRow.signedAt` now set) between this method's caller's pre-transaction
      // read and this lock actually being acquired. Reject rather than silently repointing
      // currentVersionId away from a version that just became fully executed.
      if (versionRow.signedAt) {
        throw new ConflictError(
          "This agreement was fully signed by another request before this revision could be applied. Please refresh and try again.",
        );
      }

      const [newVersionRow] = await tx
        .insert(agreementVersion)
        .values({
          agreementId: input.agreementId,
          versionNumber: versionRow.versionNumber + 1,
          parentVersionId: versionRow.id,
          isOriginal: false,
          producedBy: "first_payment_date_revision",
          frequency: input.frequency,
          feeAllocation: input.feeAllocation,
          terms: input.terms as object,
        })
        .returning();
      if (!newVersionRow) throw new ConfigurationError("agreement_version insert returned no row during atomic revision apply");

      if (input.schedule.length > 0) {
        await tx.insert(installmentScheduleItem).values(
          input.schedule.map((item) => ({
            agreementVersionId: newVersionRow.id,
            sequenceNumber: item.sequenceNumber,
            dueDate: item.dueDate,
            amountMinorUnits: item.amountMinorUnits,
          })),
        );
      }

      await tx.update(agreement).set({ currentVersionId: newVersionRow.id }).where(eq(agreement.id, input.agreementId));

      return { newVersionId: newVersionRow.id, newVersionNumber: newVersionRow.versionNumber };
    });
  }

  /**
   * FINAL corrective pass (Codex: `reviseTermsBeforeSignature` had the same non-atomic defect
   * `applyFirstPaymentDateRevisionAtomically` above was built to close) — see
   * `RevisionApplicationRepository.applyGeneralTermsRevisionAtomically`'s own doc comment in
   * agreementService.ts for the full race this closes. Deliberately shares this class (not a second,
   * competing transactional implementation) and the exact same lock order — only the status
   * validation/transition differs, since a pre-signature terms revision starts from a different set
   * of statuses and (unlike a first-payment-date revision) must also advance status to the other
   * party's review stage as part of the same atomic write.
   */
  async applyGeneralTermsRevisionAtomically(
    input: Parameters<RevisionApplicationRepository["applyGeneralTermsRevisionAtomically"]>[0],
  ): Promise<RevisionApplicationResult> {
    const db = this.db;
    return db.transaction(async (tx) => {
      if (this.hooks?.beforeAgreementLock) await this.hooks.beforeAgreementLock();
      // Lock order (agreement, then its current version) — MUST match
      // DrizzleSigningApplicationRepository's identical ordering exactly, for the same reason as
      // applyFirstPaymentDateRevisionAtomically above.
      const agreementRows = await tx.select().from(agreement).where(eq(agreement.id, input.agreementId)).for("update").limit(1);
      if (this.hooks?.afterAgreementLock) await this.hooks.afterAgreementLock();
      const agreementRow = agreementRows[0];
      if (!agreementRow) throw new ConfigurationError("agreement not found during atomic revision apply");
      // FINAL corrective pass, round 2 (Codex): must be the EXACT status this attempt was authorized
      // against, never "any generally-revisable status" — otherwise a stale debtor-turn revision
      // could incorrectly survive a concurrent acknowledgment that legitimately advanced the SAME
      // version to the other party's review status.
      if (agreementRow.status !== input.expectedStatus) {
        throw new ConflictError(
          `This agreement is no longer awaiting review in the status it was reviewed against (it is now "${agreementRow.status}") — someone else's action changed it first. Please refresh and try again.`,
        );
      }
      if (agreementRow.currentVersionId !== input.baseVersionId) {
        throw new ConflictError("This agreement's terms were already revised by another request. Please refresh and try again.");
      }

      const versionRows = await tx.select().from(agreementVersion).where(eq(agreementVersion.id, input.baseVersionId)).for("update").limit(1);
      const versionRow = versionRows[0];
      if (!versionRow) throw new ConfigurationError("agreement_version not found during atomic revision apply");
      if (versionRow.agreementId !== input.agreementId) {
        throw new ConflictError("This version does not belong to the specified agreement — refusing to revise.");
      }
      // Same core race applyFirstPaymentDateRevisionAtomically closes: a concurrent
      // acceptance/signing progression may have advanced this agreement (and possibly signed this
      // very version) between this method's caller's pre-transaction read and this lock actually
      // being acquired. The `expectedStatuses` check above already catches an advanced *agreement*
      // status; rejecting an already-signed *version* too is defense-in-depth against ever
      // repointing `currentVersionId` away from a version that became executed.
      if (versionRow.signedAt) {
        throw new ConflictError(
          "This agreement was fully signed by another request before this revision could be applied. Please refresh and try again.",
        );
      }

      const [newVersionRow] = await tx
        .insert(agreementVersion)
        .values({
          agreementId: input.agreementId,
          versionNumber: versionRow.versionNumber + 1,
          parentVersionId: versionRow.id,
          isOriginal: false,
          producedBy: input.producedBy,
          frequency: input.frequency,
          feeAllocation: input.feeAllocation,
          terms: input.terms as object,
        })
        .returning();
      if (!newVersionRow) throw new ConfigurationError("agreement_version insert returned no row during atomic revision apply");

      if (input.schedule.length > 0) {
        await tx.insert(installmentScheduleItem).values(
          input.schedule.map((item) => ({
            agreementVersionId: newVersionRow.id,
            sequenceNumber: item.sequenceNumber,
            dueDate: item.dueDate,
            amountMinorUnits: item.amountMinorUnits,
          })),
        );
      }

      // Repoint currentVersionId AND advance status to the other party's review stage in the same
      // write — the exact combination `reviseTermsBeforeSignature`'s previous non-atomic sequence
      // could leave split (e.g. currentVersionId repointed but status left stale, or vice versa,
      // under a concurrent racing write in between).
      await tx
        .update(agreement)
        .set({ currentVersionId: newVersionRow.id, status: input.newStatus })
        .where(eq(agreement.id, input.agreementId));

      return { newVersionId: newVersionRow.id, newVersionNumber: newVersionRow.versionNumber };
    });
  }
}
