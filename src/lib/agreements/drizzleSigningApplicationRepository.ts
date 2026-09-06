import "server-only";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { agreement, agreementVersion, signatureEvent } from "@/db/schema";
import { ConfigurationError, ConflictError, CounterpartyMustSignFirstError, ScheduleRevisionRequiredError } from "@/lib/errors";
import { isPastDate } from "./schedule";
import { computeVersionHash } from "./documentHash";
import type { AgreementTerms, SigningApplicationRepository, SigningApplicationResult } from "./agreementService";

/**
 * PRSprint 12 (docs/prsprints/PRSPRINT_12_ELECTRONIC_SIGNATURES_PDFS_IMMUTABLE_RECORDS.md): see
 * SigningApplicationRepository's own doc comment in agreementService.ts for why this exists as a
 * single, hand-written multi-table transaction rather than several separate repository calls —
 * mirrors DrizzleAmendmentApplicationRepository's exact shape and rationale. Writes directly against
 * the raw Drizzle table objects (not through DrizzleAgreementVersionRepository/
 * DrizzleAgreementRepository/DrizzleSignatureEventRepository) specifically so every statement below
 * shares the same `tx` and therefore the same commit/rollback unit — those repositories' existing
 * methods each open their own `getDb()` connection and are deliberately left untouched (still
 * correct, still tested, still used for reads and for every non-completing-signature write, e.g. the
 * initial agreement/version insert).
 *
 * R05 (DB integrity & concurrency hardening): `AgreementService.signAgreementWithEvidence`'s own
 * pre-transaction checks (status, currentVersionId, signing order, first-payment-date validity) read
 * `agreement`/`agreementVersion` before this transaction even starts, so they can be stale by the time
 * it commits — a concurrent revision (`reviseFirstPaymentDate`), cancellation, or duplicate signing
 * request can invalidate any of them in that gap. `SELECT ... FOR UPDATE` locks both rows fresh here,
 * inside the transaction, and every one of those checks is re-run against that locked, current data
 * immediately before any write — closing the race rather than merely narrowing it. A losing signature
 * attempt throws (rolling back this transaction entirely, writing nothing) with the exact same error
 * type `signAgreementWithEvidence`'s own pre-transaction check would throw for the equivalent
 * non-racing case, so callers/tests observe identical behavior either way.
 *
 * R07 corrective pass (Codex finding G): `DrizzleRevisionApplicationRepository`
 * (`drizzleRevisionApplicationRepository.ts`) applies `reviseFirstPaymentDate`'s mutation inside its
 * own transaction using the EXACT SAME lock order this class uses (agreement row, then its current
 * `agreement_version` row, both `FOR UPDATE`) — that shared ordering is what makes signing and
 * revision mutually exclusive at the database level: whichever transaction's `SELECT ... FOR UPDATE`
 * on the `agreement` row commits first, the other blocks on that same row until it releases, then
 * re-reads and re-validates against the now-current data. Neither can ever silently overwrite the
 * other's completed result. See that class's own doc comment for the revision side of this pairing.
 */
/**
 * FINAL corrective pass (R05-B/R05-C determinism, Codex: "Use DB locks/barriers or explicit test
 * hooks around the REAL production repositories" — "do not rely merely on Promise.all" or
 * "repeated probability-based races"). Postgres gives no way for a test to force which of two
 * independently-dispatched real connections wins a row-lock queue, so proving BOTH valid winning
 * orders deterministically requires pausing one real transaction, mid-flight, at a specific known
 * point — while it is genuinely holding (or about to request) the exact row lock the other
 * competing operation needs — long enough for the test to confirm the other side is really blocked
 * before letting the first one continue. Both hooks default to `undefined` and every production call
 * site (`new DrizzleSigningApplicationRepository()`, no second argument) never sets them, so this can
 * never run, or even be checked, outside `*.postgres.test.ts`.
 */
export interface AgreementLockTestHooks {
  /** Awaited at the very start of the transaction, before the `agreement` row lock is even requested. */
  beforeAgreementLock?: () => Promise<void>;
  /** Awaited immediately after the `agreement` row lock has been GRANTED — from this point until the hook resolves, this transaction is genuinely holding that lock. */
  afterAgreementLock?: () => Promise<void>;
}

export class DrizzleSigningApplicationRepository implements SigningApplicationRepository {
  /**
   * R07 corrective pass: `db` is injectable (defaulting to the shared production singleton) solely
   * so `*.postgres.test.ts` concurrency suites can hand two instances of this SAME class (or this
   * class paired with `DrizzleRevisionApplicationRepository`) two genuinely distinct PostgreSQL
   * connections — proving real transaction overlap/lock contention, which a single shared `max: 1`
   * connection structurally cannot exhibit. Every production call site
   * (`new DrizzleSigningApplicationRepository()`, no argument) is unaffected. `hooks` is the same
   * kind of test-only affordance — see `AgreementLockTestHooks`'s own doc comment.
   */
  constructor(
    private readonly db: Database = getDb(),
    private readonly hooks?: AgreementLockTestHooks,
  ) {}

  async applySigningAtomically(
    input: Parameters<SigningApplicationRepository["applySigningAtomically"]>[0],
  ): Promise<SigningApplicationResult> {
    const db = this.db;
    return db.transaction(async (tx) => {
      if (this.hooks?.beforeAgreementLock) await this.hooks.beforeAgreementLock();
      // Lock order (agreement, then version) is fixed and consistent with every other write path
      // that touches both — see this class's own doc comment for the revision-side pairing that
      // makes this ordering load-bearing, not just a style choice.
      const agreementRows = await tx.select().from(agreement).where(eq(agreement.id, input.agreementId)).for("update").limit(1);
      if (this.hooks?.afterAgreementLock) await this.hooks.afterAgreementLock();
      const agreementRow = agreementRows[0];
      if (!agreementRow) throw new ConfigurationError("agreement not found during atomic signing apply");
      if (agreementRow.status !== "awaiting_signatures") {
        throw new ConflictError(
          `This agreement is no longer awaiting signatures (it is now "${agreementRow.status}") — someone else's action changed it first. Please refresh and try again.`,
        );
      }
      if (agreementRow.currentVersionId !== input.agreementVersionId) {
        throw new ConflictError(
          "This agreement's terms were revised by another request before your signature could be recorded. Please review the current version and try again.",
        );
      }

      const versionRows = await tx.select().from(agreementVersion).where(eq(agreementVersion.id, input.agreementVersionId)).for("update").limit(1);
      const versionRow = versionRows[0];
      if (!versionRow) throw new ConfigurationError("agreement_version not found during atomic signing apply");
      // Codex finding F: explicit ownership proof — `agreement.currentVersionId === versionRow.id`
      // (checked above) is not by itself a guarantee this version actually belongs to this
      // agreement; it only proves the *pointer* matches. This closes that gap directly rather than
      // relying on the pointer check alone.
      if (versionRow.agreementId !== input.agreementId) {
        throw new ConflictError("This version does not belong to the specified agreement — refusing to sign.");
      }

      const alreadySigned = input.role === "creditor" ? versionRow.creditorSignedAt !== null : versionRow.debtorSignedAt !== null;
      if (alreadySigned) {
        return { alreadySigned: true, bothSigned: false, documentHash: null, signatureEventId: null, agreementHashAtSigning: null };
      }

      // R05: re-run the counterparty-first check against this transaction's own fresh, locked
      // version — `originatorRole` itself needs no re-resolution (see that field's own doc comment
      // in agreementService.ts), but which counterparty has and hasn't signed absolutely can have
      // changed since the pre-transaction read.
      if (input.role === input.originatorRole) {
        const counterpartySignedAt = input.originatorRole === "creditor" ? versionRow.debtorSignedAt : versionRow.creditorSignedAt;
        if (!counterpartySignedAt) {
          throw new CounterpartyMustSignFirstError();
        }
      }
      // R05: re-run the expired-first-payment-date check against the fresh version's own terms —
      // matches signAgreementWithEvidence's own pre-transaction message exactly.
      const freshTerms = versionRow.terms as AgreementTerms;
      if (isPastDate(freshTerms.firstPaymentDate)) {
        throw new ScheduleRevisionRequiredError(
          `The proposed first payment date (${freshTerms.firstPaymentDate}) has already passed. This agreement's schedule must be revised before it can be signed.`,
        );
      }

      await tx
        .update(agreementVersion)
        .set(input.role === "creditor" ? { creditorSignedAt: input.signedAt } : { debtorSignedAt: input.signedAt })
        .where(eq(agreementVersion.id, input.agreementVersionId));

      let signatureEventId: string | null = null;
      // R05: computed from `versionRow` — the exact version this transaction just locked and
      // re-validated as current — never from a pre-transaction value the caller might supply, so the
      // recorded signature can never be evidenced against stale terms (see SigningEvidenceInput's own
      // doc comment for the risk this closes).
      let agreementHashAtSigning: string | null = null;
      if (input.evidence) {
        agreementHashAtSigning = computeVersionHash({
          agreementId: versionRow.agreementId,
          versionNumber: versionRow.versionNumber,
          terms: freshTerms,
        });
        const [eventRow] = await tx
          .insert(signatureEvent)
          .values({
            agreementVersionId: input.agreementVersionId,
            signerUserId: input.evidence.signerUserId,
            signerProfileKind: input.evidence.signerProfileKind,
            signerProfileId: input.evidence.signerProfileId,
            signerRole: input.evidence.signerRole,
            signingAuthority: input.evidence.signingAuthority,
            signerTitle: input.evidence.signerTitle,
            consentCaptured: input.evidence.consentCaptured,
            consentVersion: input.evidence.consentVersion,
            authMethod: input.evidence.authMethod,
            ipAddress: input.evidence.ipAddress,
            deviceInfo: input.evidence.deviceInfo as object | null,
            timezone: input.evidence.timezone,
            agreementHashAtSigning,
            signedAt: input.signedAt,
          })
          .returning();
        if (!eventRow) throw new ConfigurationError("signature_event insert returned no row during atomic signing apply");
        signatureEventId = eventRow.id;
      }

      const bothSigned =
        (input.role === "creditor" || versionRow.creditorSignedAt !== null) &&
        (input.role === "debtor" || versionRow.debtorSignedAt !== null);
      if (!bothSigned) {
        return { alreadySigned: false, bothSigned: false, documentHash: null, signatureEventId, agreementHashAtSigning };
      }

      const documentHash = computeVersionHash({
        agreementId: versionRow.agreementId,
        versionNumber: versionRow.versionNumber,
        terms: freshTerms,
      });
      await tx
        .update(agreementVersion)
        .set({ documentHash, signedAt: input.signedAt })
        .where(eq(agreementVersion.id, input.agreementVersionId));
      await tx.update(agreement).set({ status: "signed" }).where(eq(agreement.id, input.agreementId));
      // Automatic per docs/STATE_MACHINES.md §1 — matches AgreementService.signAgreement's own
      // pre-PRSprint-12 sequence exactly, just now inside the same transaction as everything above.
      await tx.update(agreement).set({ status: "first_payment_pending" }).where(eq(agreement.id, input.agreementId));

      return { alreadySigned: false, bothSigned: true, documentHash, signatureEventId, agreementHashAtSigning };
    });
  }
}
