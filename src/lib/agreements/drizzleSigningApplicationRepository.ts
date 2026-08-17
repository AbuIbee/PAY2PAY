import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, agreementVersion, signatureEvent } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
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
 */
export class DrizzleSigningApplicationRepository implements SigningApplicationRepository {
  async applySigningAtomically(
    input: Parameters<SigningApplicationRepository["applySigningAtomically"]>[0],
  ): Promise<SigningApplicationResult> {
    const db = getDb();
    return db.transaction(async (tx) => {
      // Re-read fresh, inside the transaction — the caller (AgreementService.signAgreementWithEvidence)
      // already checked this against a read taken *before* the transaction started; this is the
      // authoritative check against two requests racing past that earlier read concurrently.
      const rows = await tx.select().from(agreementVersion).where(eq(agreementVersion.id, input.agreementVersionId)).limit(1);
      const versionRow = rows[0];
      if (!versionRow) throw new ConfigurationError("agreement_version not found during atomic signing apply");
      const alreadySigned = input.role === "creditor" ? versionRow.creditorSignedAt !== null : versionRow.debtorSignedAt !== null;
      if (alreadySigned) {
        return { alreadySigned: true, bothSigned: false, documentHash: null, signatureEventId: null };
      }

      await tx
        .update(agreementVersion)
        .set(input.role === "creditor" ? { creditorSignedAt: input.signedAt } : { debtorSignedAt: input.signedAt })
        .where(eq(agreementVersion.id, input.agreementVersionId));

      let signatureEventId: string | null = null;
      if (input.evidence) {
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
            agreementHashAtSigning: input.evidence.agreementHashAtSigning,
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
        return { alreadySigned: false, bothSigned: false, documentHash: null, signatureEventId };
      }

      const documentHash = computeVersionHash({
        agreementId: versionRow.agreementId,
        versionNumber: versionRow.versionNumber,
        terms: versionRow.terms as AgreementTerms,
      });
      await tx
        .update(agreementVersion)
        .set({ documentHash, signedAt: input.signedAt })
        .where(eq(agreementVersion.id, input.agreementVersionId));
      await tx.update(agreement).set({ status: "signed" }).where(eq(agreement.id, input.agreementId));
      // Automatic per docs/STATE_MACHINES.md §1 — matches AgreementService.signAgreement's own
      // pre-PRSprint-12 sequence exactly, just now inside the same transaction as everything above.
      await tx.update(agreement).set({ status: "first_payment_pending" }).where(eq(agreement.id, input.agreementId));

      return { alreadySigned: false, bothSigned: true, documentHash, signatureEventId };
    });
  }
}
