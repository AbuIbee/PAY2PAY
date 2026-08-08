SPRINT 6 OBJECTIVE:
Implement electronic signature evidence and immutable agreement document generation.

Do not assume that implementation alone establishes legal enforceability.

Capture:

- signer identity
- profile/legal entity
- signer role
- signing authority where business
- timestamp
- timezone
- IP
- device metadata
- authentication method
- consent version
- agreement version
- agreement hash
- signature event ID

Require elevated authentication before signing:

- Call Sprint 2's `requireStepUp(user, "sign_agreement")` immediately before capturing a
  signature. A failed or missing step-up blocks the signature — no signature event is recorded.
- Call Sprint 3's `isFullyVerified(profile)` for both the signer's profile and (for a business
  signer) the business profile. Block signing with a clear, non-punitive message directing the
  user to complete verification if the profile is not `FULL_VERIFIED`. This gate depends only on
  Sprint 3's interface, not on Sprint 9's real KYC/KYB provider being integrated yet — during
  Sprints 1–8, `FULL_VERIFIED` is reachable only through Sprint 3's audited manual/mock path, which
  is sufficient for this gate to function correctly and for tests to pass. Sprint 9 later upgrades
  the mechanism that produces `FULL_VERIFIED` without requiring any change here.

Generate a stable PDF containing:

- agreement number
- parties
- debt purpose
- financial terms
- payment schedule
- fees
- no-interest terms
- amendment terms
- payment authorization placeholder where applicable
- signatures
- witness attestations where applicable
- agreement version
- hash/reference

Store PDFs in Supabase Storage using private buckets and authorized signed URLs.

Never expose private buckets publicly.

Hash document content and preserve hash.

Both parties must have authorized access to the signed PDF.

Implement immutable versioning.

Do not implement payment authorization yet except required schema/interface placeholders.

Tests:

- signature authorization
- second-party signature
- unauthorized signer
- signing blocked without a passed step-up challenge
- signing blocked when signer profile is not FULL_VERIFIED
- signing blocked when business profile is not FULL_VERIFIED (business signer)
- business signer authority
- PDF generated
- document access isolation
- hash stability
- signed agreement cannot be edited

Update docs.

Stop.