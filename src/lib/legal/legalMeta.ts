/**
 * B0-C (Privacy Policy / Terms of Service — contract freeze + implementation): the single source of
 * truth for facts that the frozen contract requires to be IDENTICAL across both public legal
 * documents (see each page's own "cross-document consistency" requirement). Keeping these values
 * here, imported by both `privacy/page.tsx` and `terms/page.tsx`, makes drift between the two
 * documents structurally impossible rather than merely something a reviewer has to notice.
 *
 * Frozen per the B0-C task specification — do not change these without a corresponding, deliberate
 * legal/business decision; this file is content-freeze bookkeeping, not a place to improvise.
 */

/** The only public product/service name either document may use — never "PAY2PAY". */
export const LEGAL_PRODUCT_NAME = "Paid2You";

/** Frozen per the B0-C task specification. Do not invent an earlier legal-policy history. */
export const LEGAL_EFFECTIVE_DATE = "September 15, 2026";
export const LEGAL_LAST_UPDATED = "September 15, 2026";

/** Matches the product's actual account-eligibility rule (Sprint 2 signup age-gating). */
export const LEGAL_MIN_AGE_TEXT = "18 years or older";

/**
 * The only real, currently-existing public contact/request mechanism for either document to point
 * to — see `PublicSupport.tsx`'s own doc comment for why no support email/phone/address is invented
 * here. Both documents must route every "how do I ask about this" moment to this one route.
 */
export const SUPPORT_ROUTE = "/support";
export const PRIVACY_ROUTE = "/privacy";
export const TERMS_ROUTE = "/terms";

/**
 * The exact phrase both documents use to describe how a user opts in to transactional SMS — never
 * "text START/a keyword to a number" (no such flow has been implemented; B0-B's only opt-in
 * mechanism is the web/application notification-preference control).
 */
export const SMS_OPT_IN_METHOD_TEXT = "through Paid2You's web or application SMS preference control";
