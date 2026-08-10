import { createHash } from "node:crypto";
import type { AgreementTerms } from "./agreementService";

/**
 * Extracted from AgreementService's private computeDocumentHash (Sprint 5) — identical algorithm
 * and input shape, unchanged behavior, just made reusable so Sprint 6's SignatureService can
 * compute the same hash for its per-signature `agreement_hash_at_signing` evidence field without
 * duplicating (and risking drift from) the hash AgreementService itself locks into
 * agreement_version.document_hash once both parties have signed.
 */
export function computeVersionHash(version: { agreementId: string; versionNumber: number; terms: AgreementTerms }): string {
  return createHash("sha256")
    .update(JSON.stringify({ agreementId: version.agreementId, versionNumber: version.versionNumber, terms: version.terms }))
    .digest("hex");
}
