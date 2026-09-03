# Open Issues

Cross-cutting implementation-time gaps discovered while building a feature, distinct from
`docs/OPEN_DECISIONS.md` (spec-level decisions the master spec itself leaves open). New entries go at
the top.

## Business signup tax-ID verification has no real provider to plug into (2026-09-03)

**Context:** the account-creation/onboarding redesign (Personal + Business signup) collects a
business's tax-ID **type** (EIN/SSN/ITIN) at signup, but deliberately never collects, transmits, or
stores the tax-ID **number** itself.

**Why:** an audit of the existing identity/KYC architecture before implementation found no compliant
mechanism for full tax-ID collection anywhere in this codebase:

- `identity_verification_record` (`src/db/schema/verification.ts`) has a `providerRef` column reserved
  for a real KYC/KYB provider, never populated by any implementation today.
- `KycKybProvider` (`src/lib/kyc/kycProvider.ts`) has **no tax-ID concept at all** — only
  government-ID-document and business-registration-number fields. Its only implementation is
  `sandboxKycProvider.ts`, a mock.
- `business_profile.ein_or_ssn_ref` (`src/db/schema/identity.ts`) already exists as a tokenized/
  encrypted-reference column ("never raw", per its own comment) but has never had anything to populate
  it with.

Per explicit product direction, this feature does not fake a mechanism that doesn't exist: business
signup collects and persists only `business_profile.tax_id_type` (metadata) and leaves
`ein_or_ssn_ref` null. No full tax-ID number is ever accepted by the signup API, logged, audited, or
returned in any response.

**What's needed to close this:** a real, provider-hosted/tokenized tax-ID verification integration —
extending `KycKybProvider`'s interface with a tax-ID submission/verification method backed by an actual
provider — at which point `business_profile.ein_or_ssn_ref` becomes populated with that provider's
token/reference, exactly as its existing column comment already anticipates. This is the same
dependency already tracked at a spec level in `docs/OPEN_DECISIONS.md` items **#16** ("No KYC/KYB
provider named") and **#19** ("Tax information-reporting not represented in architecture") — this entry
is the concrete, implementation-level instance of that same gap surfaced by the signup redesign.
