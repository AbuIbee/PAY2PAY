SPRINT 3 OBJECTIVE:
Implement complete personal and business profile architecture.

Read all project documentation first.

Required:

PERSONAL PROFILE

One per authenticated user.

Fields should follow the canonical data model and privacy requirements.

BUSINESS PROFILE

A user may create multiple separately verified business profiles.

Each business must have:
- legal name
- display name
- entity type
- business address
- country
- state
- verification status
- owner relationship
- creation timestamp
- status

Do not collect unnecessary sensitive information yet.

Business verification fields that depend on the KYC/KYB provider may remain
provider-controlled or pending.

IDENTITY VERIFICATION ARCHITECTURE

Sprint 3 owns the internal identity-verification architecture (data model, tiers, and gating
interface). Sprint 9 owns the actual KYC/KYB provider integration that fills this architecture in —
this sprint must not depend on a live provider to be complete.

Implement two tiers per the master specification:

- BASIC: satisfied by Sprint 2's signup (verified email, verified phone, password/passkey, basic
  profile). No new work here.
- FULL: legal name, date of birth, residential address, government-issued ID reference, selfie/
  liveness result, bank-account-ownership confirmation, payment-provider approval — for business
  profiles, additionally legal business name, entity type, EIN/SSN where appropriate, business
  address, authorized representative, beneficial-owner information where required, verified
  business bank account, payment-provider business verification.

Model verification status as an explicit per-profile state (e.g., `UNVERIFIED`, `BASIC`,
`FULL_PENDING`, `FULL_VERIFIED`, `FULL_REJECTED`), not a boolean. Until Sprint 9 wires a real or
sandbox KYC/KYB provider, `FULL_PENDING`/`FULL_VERIFIED` may be reached only through an explicit,
audited manual/mock verification path — never silently defaulted to verified.

Expose a single gating interface other sprints call rather than re-deriving verification status
themselves: `isFullyVerified(profile) -> boolean`. Sprint 6 (signing) and Sprints 9–12 (payments)
depend on this interface, not on any specific provider, so they are buildable before Sprint 9's
real integration lands.

Do not implement the government-ID scan, liveness check, or bank-ownership check itself here —
that is Sprint 9's provider-integration work. This sprint implements the state model, the storage
of verification artifacts/references, and the gating interface only.

PRICING / ACCOUNT PLAN ARCHITECTURE

Sprint 3 owns the pricing/account-plan data model (master spec §19). Implement configurable
pricing tables — do not hard-code speculative prices:

- personal: limited free plan, monthly subscription option, pay-per-agreement option,
  per-successful-payment fees
- free-tier allowance measured by number of agreements and number of included successful
  payments, never by total dollar amount
- business: standard annual fee, small transaction fee, payment-processing costs per the signed
  fee allocation; each separately verified business profile may require its own subscription
- pricing changes apply prospectively only and never rewrite a signed agreement's fee terms
- an existing active agreement is never terminated solely because a personal user exceeds a
  free-tier allowance

Sprint 12's ACH-vs-debit-card fee-reallocation rule reads from this pricing model; it does not
duplicate it.

PROFILE SWITCHER

Implement context switching between:
- Personal
- Business A
- Business B
- etc.

The active profile must be explicit.

Authorization may not trust an arbitrary profile_id from the browser.

Every server action must verify that the authenticated user has permission for the
selected profile.

Implement dashboards:

Personal:
- Money I Owe
- Money Owed to Me
- Agreements
- Upcoming Payments
- Requests

Business:
- Receivables
- Payables
- Agreements
- Customers
- Staff placeholder
- Reports placeholder

No fake financial data.

Empty state values must reflect actual stored data.

BUSINESS CLASSIFICATION

Commercial agreements are business activity.

A verified business bank account later receiving funds will require business
classification.

Do not implement bank accounts yet.

DATABASE

Create appropriate migrations, constraints, indexes, and RLS.

TEST:

- one personal profile maximum;
- multiple owned businesses allowed;
- cross-user isolation;
- cross-business isolation;
- unauthorized profile switching blocked;
- deleted/disabled business cannot be selected;
- business data never leaks into personal context;
- verification status cannot self-report as FULL_VERIFIED without the audited manual/mock path;
- `isFullyVerified` returns false for any tier below FULL_VERIFIED;
- free-tier allowance measured by agreement/payment count, not dollar amount;
- pricing change does not alter an already-signed agreement's fee terms;
- active agreement not terminated solely for exceeding free-tier allowance.

Run full verification.

Update documentation.

Stop after Sprint 3.