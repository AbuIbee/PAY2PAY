# Production Legal Review

"PAID2YOU — MASTER P0" (2026-10-03), Section 44/66. This document is a REVIEW AID for the owner and
counsel — it is not itself a legal approval, and nothing in it should be read as one.

Claude (the implementation engineer) does **not** mark any item below as `OWNER APPROVED` or
`COUNSEL APPROVED`. Those columns stay blank until the owner (or counsel, if the owner chooses to
involve counsel) fills them in outside this document.

Each live legal document route is backed by `src/components/LegalPlaceholder.tsx`. "PAID2YOU —
MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 8-I: that component no longer renders a
development-placeholder banner to production visitors (an earlier version displayed an alarming
"this page is a placeholder, do not rely on it" notice on every visit — removed by owner
directive). The draft/not-yet-counsel-reviewed status documented in this file is still entirely
real; it is simply no longer re-stated to every end user on every page load. It remains tracked
here, and the formal approval status remains:

**OWNER APPROVED: NO**
**LEGAL APPROVED: NO**

until the owner (or counsel, if the owner chooses to involve counsel) actually reviews and signs
off — nothing in this document, or in the production pages themselves, claims otherwise.

## Status categories used below

- **PRODUCT FACT** — a statement about what the application actually does today, verifiable by
  reading the code.
- **DRAFT LEGAL LANGUAGE** — prose intended to become binding legal language, not yet reviewed.
- **OWNER DECISION** — a commercial/product choice only the Paid2You owner can make.
- **COUNSEL REVIEW ITEM** — something that should specifically be checked by counsel before launch.
- **LAUNCH BLOCKER** — must be resolved before a real Business can be onboarded in production.

## 1. Terms of Service

Route: `/terms`. Current version: `2026-10-03` (`CURRENT_LEGAL_DOCUMENT_VERSIONS.terms`,
`src/lib/legal/legalDocumentVersions.ts`).

| Item | Category | Note |
|---|---|---|
| Describes Personal accounts as free, Business accounts as subscription-based | PRODUCT FACT | Matches `pricingService`/seeded catalog. |
| Describes Business organization membership/roles/removal | PRODUCT FACT | Matches `organizationRoleService`. |
| Never names a specific verification or payment provider | DRAFT LEGAL LANGUAGE (deliberate) | Written vendor-agnostically BEFORE Middesk/Stripe were approved; remains accurate now that they are. Vendor names are a documentation (`PRODUCTION_PROVIDER_READINESS.md`) and configuration-manifest concern, not something this page needs to assert to end users. |
| Does not mention direct bank repayment services as live | PRODUCT FACT | Correct — Direct Banking is not implemented in this worktree (Phase 3B). |
| Full Terms (account misuse, security, dispute handling, jurisdiction, limitation of liability) | COUNSEL REVIEW ITEM | Not drafted in detail — `LegalPlaceholder`'s own banner already discloses this is pre-launch. |
| Whether/how Terms differ for Enterprise Businesses with a negotiated contract | OWNER DECISION | Not yet addressed in the page; Enterprise is described as "contact Paid2You directly" without more detail. |

**Launch blocker:** none structurally — the page is honest about its own incompleteness. The owner
should decide whether a more complete Terms draft is required before Day 4, or whether the current
honest-placeholder framing is acceptable for a controlled first Business.

## 2. Privacy Policy

Route: `/privacy`. Current version: `2026-10-03`.

| Item | Category | Note |
|---|---|---|
| Describes business verification data flow (Tax ID/EIN sent to provider, only last4 stored by Paid2You) | PRODUCT FACT | Matches `businessVerificationService.ts`'s own data-minimization contract, now implemented for real by `middeskBusinessVerificationProvider.ts`. |
| Describes subscription billing data flow (payment-method metadata only, full credentials held by provider) | PRODUCT FACT | Matches `stripePlatformBillingProvider.ts`'s own payment-data-boundary contract (Section 18). |
| Does not name Middesk/Stripe/Resend/Supabase by name | DRAFT LEGAL LANGUAGE (deliberate) | Same vendor-agnostic choice as Terms — accurate either way. |
| Data retention periods, deletion/export rights, cross-border transfer | COUNSEL REVIEW ITEM | Not drafted. |
| Whether Middesk/Stripe should be named explicitly as sub-processors | OWNER DECISION (often also a COUNSEL REVIEW ITEM) | Many privacy regimes expect a sub-processor list; this page currently describes roles ("our verification provider") without naming vendors. Flagging for explicit owner/counsel decision before a wider (non-controlled) launch. |

**Launch blocker:** none structurally for a controlled first Business; the sub-processor-naming
question above should be resolved before a public launch.

## 3. Business Subscription Policy

Route: `/business-subscription-policy`. Current version: `2026-10-03`.

| Item | Category | Note |
|---|---|---|
| Starter $99 (0-24), Core $199 (25-99), Growth $699 (100-499), Scale $1,999 (500-1,999), Enterprise $5,000+ (2,000+, negotiated) | PRODUCT FACT | Matches `seedCanonicalBusinessPlans.ts`/`BUSINESS_PLAN_VOLUME_BANDS` and the Stripe price-ID mapping in `getPlatformBillingProvider.ts` exactly. |
| Zero-usage Starter still owed, no free Business tier | PRODUCT FACT | Matches `PlatformBillingService`/pricing entitlement enforcement. |
| No silent overage charge; no silent plan change | PRODUCT FACT | `ArrangementUsageLimitExceededError` blocks server-side; no auto-upgrade code path exists. |
| No self-service downgrade; explained as a known, deliberate limitation | PRODUCT FACT | Matches `change-plan/route.ts`'s own hard rejection. |
| "handled case by case while this policy matures" (nonpayment/suspension) | OWNER DECISION + LAUNCH BLOCKER CANDIDATE | This is honest about being unresolved, but an owner should decide a concrete nonpayment-to-suspension timeline (e.g. "N days past due") before this policy is relied upon beyond a controlled first Business — otherwise "suspension" has no actual trigger condition anywhere in the code (`BusinessActivationService` does not currently suspend for a past-due invoice). |
| Enterprise custom-pricing framing | PRODUCT FACT | Matches `setNegotiatedTerms`/`enterpriseNegotiatedTerms.test.ts`. |

**Launch blocker:** the nonpayment→suspension gap above is real: the policy describes a
consequence ("may eventually lead to suspension") that no code path currently implements. Either
(a) the owner accepts that gap for a controlled first Business (nothing destructive happens — access
is simply never revoked for nonpayment yet), or (b) a future phase must implement it before the
policy's own words become fully accurate. Recommend (a) for Days 4-5, explicitly flagged in
`docs/FIRST_LIVE_BUSINESS_ACCEPTANCE.md`.

## 4. Recurring Payment Authorization

Route: `/recurring-payment-authorization`. Current version: `2026-10-03`.

| Item | Category | Note |
|---|---|---|
| Scoped explicitly to Paid2You's own subscription charge, never customer repayment | PRODUCT FACT | Matches `platformBillingProvider.ts`'s own doc comment — structurally a different interface from `paymentProvider.ts`. |
| "Paid2You does not collect your raw card or bank account details directly" | PRODUCT FACT | Matches `StripePlatformBillingProvider`'s hosted-tokenization-only design (Section 18) — confirmed, no raw-card code path exists anywhere in this adapter. |
| Version/timestamp recorded per acceptance | PRODUCT FACT | Matches `legal_acceptance` table + `LegalAcceptanceService`. |
| Withdrawal = cancellation, effective at period end | PRODUCT FACT | Matches `PlatformBillingService.cancelAtPeriodEnd`. |

**Launch blocker:** none identified.

## Cross-cutting items

- **Legal acceptance engine** (versioning, re-acceptance on version bump, cross-tenant/spoof
  protection, Business-activation gating) is implemented and covered by
  `src/lib/legal/legalAcceptanceService.test.ts` and
  `src/lib/legal/drizzleLegalAcceptanceRepository.postgres.test.ts` — re-verified this phase (see
  Section 45 in `docs/CODEX_P0_VERIFICATION_HANDOFF.md`).
- **No document in this review claims attorney approval, legal approval, legal sufficiency, or full
  compliance** — this review itself does not either.
- **Owner-approval and counsel-approval columns are intentionally absent from the tables above** —
  add them (or a parallel sign-off log) once the owner has actually reviewed each item.
