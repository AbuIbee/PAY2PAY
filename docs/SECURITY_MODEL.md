# Deliverable 10: Security Threat Model

Source: `docs/PAY2PAY_MASTER_SPEC.md`, Section 36 Deliverable 10, using **STRIDE**
(Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of
Privilege) as the methodology, applied against the trust boundaries in `docs/ARCHITECTURE.md` §3
and the controls already specified in `docs/deliverables/04-functional-requirements.md` (FR-*) and
`docs/deliverables/05-nonfunctional-requirements.md` (NFR-*). Every threat named in the spec is
covered below. This is a design-time threat model, not a penetration-test report or a claim that
any control has been implemented or verified.

## 0. Coverage across P2P, B2C, C2B, and B2B

Most threats below apply uniformly across relationship shapes. Two are shape-specific and called
out in their entries: **Business-profile confusion** (P2P/personal vs. business misrouting) and
**Collusion**/**Staff abuse** (materially higher blast radius in B2B, where an authorized
representative can bind an entire business, and where two staff members colluding can defeat
two-person approval).

## 1. Account takeover

**STRIDE:** Spoofing, Elevation of Privilege.

**Scenario:** An attacker obtains a user's credentials or session and acts as them — signing
agreements, changing bank/payout details, or approving settlements.

**Mitigations already specified:**
- MFA required before every sensitive action (FR-MFA-001), with passkeys/authenticator apps
  preferred over SMS (FR-MFA-002).
- Secure, rotating session tokens with revocation on logout/credential change/suspected compromise
  (NFR-SEC-006).
- Device/login monitoring feeding fraud review (NFR-SEC-007, FR-FRAUD-002).
- Rate limiting on authentication endpoints (NFR-SEC-004).

**Residual risk:** SMS-fallback MFA remains comparatively weaker (the spec itself deprioritizes it,
FR-MFA-002); social-engineering-based MFA bypass (e.g., SIM swap, help-desk impersonation) is a
process/operational risk, not something the technical architecture alone eliminates.

## 2. Forged signatures

**STRIDE:** Spoofing, Tampering, Repudiation.

**Scenario:** Someone signs on behalf of another party without authority, or a legitimate signer
later falsely disclaims a valid signature.

**Mitigations:** these controls support attribution and evidentiary integrity for a signature
independent of full KYC/KYB — a signature can operationally occur before full identity verification
completes:
- Authenticated account/session — signing requires a logged-in, session-verified user.
- A fresh step-up/MFA challenge immediately before signing (FR-MFA-001), separate from and not
  satisfied by full KYC.
- Agreement-party authorization — only a party the agreement actually names may sign
  (`authorizeEitherParty`), and, for a business signer, a separate signing-authority check
  (account owner or an authorized staff representative, FR-B2B-002).
- Profile identity/name information already on file (usable first/last name where applicable).
- Full signature-event capture — consent, identity attribution, IP, device, timestamp, timezone,
  auth method, document hash (FR-SIG-001).
- Tamper-evident hashing, immutable version history, and agreement/version integrity checks
  (FR-SIG-003).
- Invitation binding to the intended contact prevents an unintended person from ever reaching the
  signing flow (FR-INV-002/004).

**Residual risk:** Ultimate assurance that the authenticated account belongs to the real-world
person it claims to be is bounded by account-recovery/session-compromise risk (see Account
takeover, #1), not by KYC/KYB provider accuracy — full identity/KYC verification is not part of the
signing gate. Full KYC/KYB, where later required for that party to receive funds or activate
payment capability, adds an additional, later financial/payment identity assurance layer — its
provider is not yet selected (open decision #16) — but is not the control that supports the
signature's attribution and evidentiary integrity; that role belongs to the mitigations above.

## 3. Altered agreements

**STRIDE:** Tampering.

**Scenario:** An actor — including an administrator — attempts to modify a signed agreement's terms
in place rather than through a proper amendment.

**Mitigations:**
- Database-level immutability once `signed_at` is set (`docs/DATA_MODEL.md` §5).
- Amendment-only change path (FR-AGR-006/007).
- Explicit administrative prohibition on altering signed agreements (FR-ADMIN-002).
- Hash-chained audit trail (FR-AUDIT-003).

**Residual risk:** Ultimately bounded by who holds database-superuser/infrastructure-level access —
an operational access-control question for the eventual hosting/ops setup, not resolved by
application-layer design alone.

## 4. Webhook spoofing

**STRIDE:** Spoofing, Tampering.

**Scenario:** An attacker sends a forged "payment cleared" or "payout completed" event to trigger a
false state transition or premature payout.

**Mitigations:**
- Mandatory signature verification before any webhook payload is trusted (NFR-SEC-005,
  FR-MONEY-003).
- State-machine-enforced application — an event implying an invalid transition for that record's
  current state is rejected/queued for review rather than applied (`docs/PAYMENT_ARCHITECTURE.md` §12).
- Explicit untrusted-until-verified trust boundary (`docs/ARCHITECTURE.md` §3).

**Residual risk:** Depends on secrets-management hygiene for the signing secret itself
(NFR-SEC-003).

## 5. Payment replay

**STRIDE:** Tampering, Repudiation.

**Scenario:** A captured or duplicated payment-initiation request or webhook event is resubmitted
to cause a duplicate charge or duplicate state transition.

**Mitigations:** Idempotency keys on every outbound payment-initiating call; webhook event dedupe by
provider event ID before application (FR-MONEY-002/003, `docs/PAYMENT_ARCHITECTURE.md` §11).

**Residual risk:** Correctness depends on disciplined idempotency-key generation/storage at
implementation time; the design closes the gap, implementation must not reopen it.

## 6. Duplicate withdrawals

**STRIDE:** Tampering.

**Scenario:** A race condition (double-submit, overlapping scheduler run, concurrent retry) causes
two charges for the same installment.

**Mitigations:** Unique constraint on `payment_attempt.idempotency_key`
(`docs/DATA_MODEL.md` §10); one-row-per-attempt model; the Scheduler design guarantees at most one
`automatic_retry` attempt per failed installment (FR-FAIL-003).

**Residual risk:** Requires correct transactional locking at implementation time (e.g., a
`SELECT ... FOR UPDATE` or equivalent guard) so two concurrent requests can't both pass an
"attempt doesn't exist yet" check before either commits — the unique constraint is the backstop,
but application-level care is still required.

## 7. Invitation interception

**STRIDE:** Spoofing, Information Disclosure.

**Scenario:** An invitation link is intercepted (email compromise, careless forwarding) and used by
an unintended person to view or accept an agreement.

**Mitigations:** Link binds to the intended phone/email (FR-INV-002/004); requires the accepting
identity to complete verification matching that binding; single-use after acceptance; expiring and
revocable; reveals no debt detail pre-authentication.

**Residual risk:** Does not protect against compromise of the *bound* party's own email/phone
account — that collapses to Account takeover (§1) risk.

## 8. Document malware

**STRIDE:** Tampering, Denial of Service.

**Scenario:** An uploaded evidence document contains malware targeting other users who later
download it, or attempts to exploit the storage/rendering pipeline.

**Mitigations:** Mandatory virus scanning before storage, rejection of infected uploads, signed URLs
rather than direct storage exposure (`docs/ARCHITECTURE.md` §7, §33).

**Residual risk:** No AV scanner catches every zero-day payload; mitigated in depth by sandboxed
preview/rendering as an implementation-time control, not eliminated by scanning alone.

## 9. Staff abuse

**STRIDE:** Elevation of Privilege, Repudiation.

**Scenario:** A business staff member exceeds intended authority (e.g., approves a settlement past
their cap) or acts against their employer's interest.

**Mitigations:** Owner-configured caps and mandatory two-person/owner-approval thresholds
(FR-STAFF-002); `staff_approval_request.approved_by_staff_id <> proposed_by_staff_id` constraint
(`docs/DATA_MODEL.md` §4); full attribution of every staff action (FR-STAFF-004); immediate
non-destructive removal (FR-STAFF-005).

**B2B note:** blast radius is materially higher in B2B — an authorized representative's signature
binds the whole business (FR-B2B-002/003) — which is exactly why B2B carries its own two-person/
owner-approval option (FR-B2B-006) on top of the general staff-permission model.

**Residual risk:** Two staff members who both collude to approve the same fraudulent action defeat
two-person approval by design — see Collusion (§14). This is an accepted residual risk requiring
fraud-pattern monitoring, not a control gap.

## 10. Administrator abuse

**STRIDE:** Elevation of Privilege, Repudiation.

**Scenario:** A platform administrator misuses elevated access — inspecting data without cause, or
attempting an unauthorized balance change.

**Mitigations:** Explicit administrative prohibitions (FR-ADMIN-002); full action attribution
(FR-ADMIN-003); append-only, hash-chained audit trail administrators cannot edit (FR-AUDIT-001,
NFR-AUDIT-002); appeals separation-of-duties (FR-APPEAL-002 — the original decision-maker is barred
from reviewing their own restriction).

**Residual risk:** Insider risk ultimately depends on personnel vetting and access-provisioning
practices — organizational controls outside this technical architecture's scope.

## 11. Cross-tenant data leakage

**STRIDE:** Information Disclosure.

**Scenario:** A user or staff member accesses another tenant's (unrelated user's or business's)
data due to an authorization bug.

**Mitigations:** Profile-scoped RLS *plus* independent application-layer authorization
(NFR-SEC-001); explicit tenant/profile isolation model (`docs/DATA_MODEL.md` §11); personal/business
separation enforced even within one login (NFR-PRIV-002).

**Residual risk:** An RLS misconfiguration or a missing application-layer check on a newly added
endpoint is an implementation-time risk; mitigated by the two-independent-layers design principle
and by dedicated row-level isolation testing (`docs/deliverables/04-functional-requirements.md`
NFR references, formalized further in Deliverable 13).

## 12. Business-profile confusion

**STRIDE:** Information Disclosure, Elevation of Privilege.

**Scenario:** A user with both a personal profile and business profile(s) routes a commercial
transaction through their personal profile — accidentally or to evade business classification and
pricing.

**Mitigations:** Business-activity classification combines user declaration, identity/business
verification, account-ownership matching, and internal risk review — explicitly not automated
detection alone (FR-PROF-004), designed to catch deliberate evasion, not just accidental confusion.

**Residual risk:** This is fundamentally a policy/detection control, not a hard technical
prevention — a determined user can still attempt misrouting; residual risk is managed through
ongoing fraud review (FR-FRAUD-002's "business activity routed through personal profiles" flag),
not eliminated at signup time.

## 13. Fraudulent debt creation

**STRIDE:** Spoofing, Repudiation.

**Scenario:** An attacker fabricates a debt agreement naming a real, uninvolved person as borrower
or creditor — e.g., to defraud them or launder funds through a sham repayment.

**Mitigations:** The borrower must independently authenticate and formally acknowledge the debt
(FR-AGR-003) — an agreement cannot bind someone without their own verified participation; invitation
binding (FR-INV-002); MFA step-up gate and business signing-authority check on signing itself
(FR-MFA-001, FR-SIG-001); Full identity/KYC verification required before either party's first
payment can be created, not merely to sign (FR-IDV-001); FR-FRAUD-002 explicitly flags
self-payments, collusive agreements, and circular payment activity.

**Residual risk:** Cannot fully prevent two colluding *real, verified* identities from creating a
sham agreement — see Collusion (§14).

## 14. Collusion

**STRIDE:** Repudiation.

**Scenario:** Two parties (or a party and a witness, or two staff members) mutually agree to
fabricate or manipulate an agreement, settlement, or approval for improper benefit.

**Mitigations:** FR-FRAUD-002 explicitly names collusive agreements, circular payment activity,
self-payments, shared bank accounts across unrelated users, and shared devices across suspicious
accounts as flaggable patterns; the audit trail preserves complete evidence for later investigation.

**Residual risk — accepted, not closed:** Collusion by definition involves consenting parties acting
outside the system's normal incentive assumptions. No technical control fully prevents it; this is
inherently a pattern-detection and investigation problem, not a preventable-by-design one. This is
the single largest residual risk in this threat model and is carried into the Risk Register
(`docs/RISK_REGISTER.md`) as an accepted operational risk requiring ongoing fraud-operations
capability, not a design defect.

## 15. Synthetic identity

**STRIDE:** Spoofing.

**Scenario:** An attacker constructs a synthetic identity (blended real and fabricated details) to
pass KYC/KYB and open an account.

**Mitigations:** Tiered verification requiring government ID, selfie/liveness, bank-account
ownership, and payment-provider approval (FR-IDV-001); business verification requiring EIN and
beneficial-owner checks (FR-IDV-002); duplicate-identity and shared-bank-account fraud flags
(FR-FRAUD-002).

**Residual risk:** Detection sophistication depends entirely on the chosen KYC/KYB provider's
capability — provider not yet selected (open decision #16). The architecture correctly delegates
this detection to a specialized provider rather than building it in-house, but that means residual
risk here is provider-dependent, not something PAY2PAY's own code can fully control.

## 16. Payout redirection

**STRIDE:** Tampering, Elevation of Privilege.

**Scenario:** An attacker changes a creditor's connected bank account or payout destination to
redirect future payouts to themselves.

**Mitigations:** Bank-account/payout-detail changes require elevated MFA (FR-MFA-001, FR-STAFF-003);
such changes are critical, non-disableable notifications alerting the legitimate account holder
immediately (FR-NOTIF-002); full audit attribution of the change (FR-AUDIT-002).

**Residual risk:** Relies on the legitimate account holder actually noticing and acting on the
critical notification promptly — a social/operational dependency layered on top of the technical
control, not eliminated by it alone.

---

## 17. Summary table

| # | Threat | STRIDE | Primary residual risk |
|---|---|---|---|
| 1 | Account takeover | S, E | SMS-fallback / social engineering |
| 2 | Forged signatures | S, T, R | Account-recovery / session-compromise risk (see #1) |
| 3 | Altered agreements | T | DB/infra superuser access control (ops-level) |
| 4 | Webhook spoofing | S, T | Signing-secret hygiene |
| 5 | Payment replay | T, R | Implementation-time key discipline |
| 6 | Duplicate withdrawals | T | Implementation-time locking discipline |
| 7 | Invitation interception | S, I | Bound party's own email/phone compromise |
| 8 | Document malware | T, D | Zero-day AV evasion |
| 9 | Staff abuse | E, R | Two-staff collusion (see #14) |
| 10 | Administrator abuse | E, R | Personnel vetting (org-level) |
| 11 | Cross-tenant leakage | I | New-endpoint implementation gaps |
| 12 | Business-profile confusion | I, E | Deliberate evasion, policy-level control only |
| 13 | Fraudulent debt creation | S, R | Two-verified-identity collusion (see #14) |
| 14 | Collusion | R | **Accepted residual — detection/investigation problem, not preventable by design** |
| 15 | Synthetic identity | S | KYC/KYB provider capability (open decision #16) |
| 16 | Payout redirection | T, E | Account holder's timely response to notification |

---

**Coverage note:** All 16 threat categories named in Section 36, Deliverable 10, are covered above
using STRIDE, each traced to specific FR-*/NFR-* controls and architectural components already
delivered. No new open decisions are introduced — residual risks here either restate open decisions
#16 (KYC/KYB provider) or are logged as accepted operational risk (Collusion, #14) in
`docs/RISK_REGISTER.md`.

*This is a design-time threat model. No penetration testing, code review, or live system exists to
verify these controls — verification is Deliverable 13's responsibility.*
