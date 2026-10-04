/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 3/4: the ONE canonical source for
 * every legal document's current version — never scattered across React components or route
 * handlers. `documentType` values match `legal_acceptance.document_type`'s own doc comment in
 * src/db/schema/platformExpansion.ts exactly (lowercase snake_case) — that comment IS the existing
 * naming convention this module follows, not a new one invented here.
 *
 * When a document's content changes, bump its version string here DELIBERATELY — nothing else in
 * this codebase derives a version automatically, so a content edit that forgets to bump this is the
 * one failure mode to guard against in review, not something this module can detect for itself.
 * Every acceptance record stores exactly which version a user accepted
 * (`legal_acceptance.document_version`); `LegalAcceptanceService` never treats an acceptance of an
 * OLDER version as current once this map moves forward (Section 9's re-acceptance requirement).
 */
export const LEGAL_DOCUMENT_TYPES = ["terms", "privacy", "business_subscription_policy", "recurring_payment_authorization"] as const;

export type LegalDocumentType = (typeof LEGAL_DOCUMENT_TYPES)[number];

export function isLegalDocumentType(value: string): value is LegalDocumentType {
  return (LEGAL_DOCUMENT_TYPES as readonly string[]).includes(value);
}

/**
 * Current version per document type. Format is an ISO date of last substantive content change —
 * simple, monotonically sortable, and immediately meaningful to an operator reading an acceptance
 * record without needing a separate changelog lookup.
 */
export const CURRENT_LEGAL_DOCUMENT_VERSIONS: Readonly<Record<LegalDocumentType, string>> = {
  terms: "2026-10-03",
  privacy: "2026-10-03",
  business_subscription_policy: "2026-10-03",
  recurring_payment_authorization: "2026-10-03",
};

/**
 * Section 8: the minimum set gating Business activation. Privacy is deliberately excluded —
 * "handle Privacy acknowledgment according to the application's actual legal/product convention,"
 * and no existing convention requires a blocking Privacy acceptance anywhere in this codebase today
 * (Phase 1's audit found zero existing acceptance wiring at all). `privacy` remains a fully
 * recordable document type (an acceptance CAN be captured for it, e.g. alongside Terms at Personal
 * signup in a later phase) — it is simply not one of the three documents that blocks a Business
 * organization from becoming ACTIVE.
 */
export const REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES: readonly LegalDocumentType[] = ["terms", "business_subscription_policy", "recurring_payment_authorization"];
