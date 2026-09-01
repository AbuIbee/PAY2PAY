import type { AgreementWithDetail } from "./agreementService";
import type { ProfileKind } from "@/lib/profiles/verificationService";

export interface PartyDisplayFields {
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  preferredEmail: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

/** Real implementation: DrizzleProfileDisplayReader (src/lib/documents). */
export interface PartyDisplayReader {
  getDisplayName(kind: ProfileKind, id: string): Promise<string>;
}

/** Real implementation: AgreementIdentitySnapshotService.getSnapshotForVersion. */
export interface PartySnapshotReader {
  getSnapshotForVersion(agreementVersionId: string): Promise<{ creditor: PartyDisplayFields; debtor: PartyDisplayFields } | null>;
}

const BLANK_IDENTITY = {
  firstName: null,
  lastName: null,
  preferredEmail: null,
  city: null,
  state: null,
  postalCode: null,
  country: null,
} as const;

/**
 * Legacy-agreement audit: which of the two identity sources actually backed a resolved party display
 * — `"snapshot"` for an immutable, structured, point-in-time-accurate read (Decision 7); `"legacy_live"`
 * for a pre-Decision-7 agreement version with no snapshot row, where only a live display-name lookup
 * is available. Exists so callers can log/tag which case they're in without re-deriving it (e.g.
 * SignatureService logs `agreement_pdf_generated_without_snapshot` the first time it generates a PDF
 * for a `"legacy_live"` version) — never surfaced as agreement-facing text, purely an internal signal.
 */
export type PartyDisplaySource = "snapshot" | "legacy_live";

/**
 * Decision 8/9: the one shared read every caller that displays agreement party identity uses —
 * SignatureService (PDF, both the executed document and the pre-signature preview) and the agreement
 * detail API (on-screen finalized agreement) — so the two can never disagree. Always prefers the
 * immutable agreement-party snapshot (Decision 7) when one exists for this version; falls back to a
 * live, display-name-only lookup (no raw id, ever) for a pre-Step-2 agreement or a legacy agreement
 * that predates Decision 7 (Decision 11).
 *
 * Legacy-agreement audit (mandatory rule): the `"legacy_live"` fallback below deliberately returns
 * ONLY `displayName` — every structured field (first/last name, email, city, state, postal code,
 * country) stays `null`. A legacy agreement's on-screen/PDF display must never silently present
 * CURRENT profile data as if it were the historical, at-signing identity — no structured field is
 * ever populated from a live lookup, only the same coarse "who is this" label the rest of the product
 * has always shown for a counterparty. This is deliberate, not a gap: no reliable structured
 * historical record exists for a pre-Decision-7 agreement, and none is fabricated here.
 */
export async function resolveAgreementPartyDisplays(
  detail: Pick<AgreementWithDetail, "agreement" | "version">,
  deps: { partySnapshots?: PartySnapshotReader; profileDisplay: PartyDisplayReader },
): Promise<{ creditor: PartyDisplayFields; debtor: PartyDisplayFields; source: PartyDisplaySource }> {
  const snapshot = await deps.partySnapshots?.getSnapshotForVersion(detail.version.id);
  if (snapshot) return { ...snapshot, source: "snapshot" };
  const [creditorName, debtorName] = await Promise.all([
    deps.profileDisplay.getDisplayName(detail.agreement.creditorProfileKind, detail.agreement.creditorProfileId),
    deps.profileDisplay.getDisplayName(detail.agreement.debtorProfileKind, detail.agreement.debtorProfileId),
  ]);
  return {
    creditor: { displayName: creditorName, ...BLANK_IDENTITY },
    debtor: { displayName: debtorName, ...BLANK_IDENTITY },
    source: "legacy_live",
  };
}
