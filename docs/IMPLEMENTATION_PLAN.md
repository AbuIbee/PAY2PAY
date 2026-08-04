# Deliverable 15: Development Work Breakdown

Source: `docs/PAY2PAY_MASTER_SPEC.md`, Section 36 Deliverable 15 ("Break the system into modules and
implementation phases. For each phase include: Goal, Features, Dependencies, Risks, Acceptance
gate, Security review gate, Testing gate"). This is the technical, module-level plan;
`docs/ROADMAP.md` is the business/stage-level plan these phases execute within (primarily Stages
1–3). **No application code is written as part of this deliverable** — this document plans the
work, it does not perform it.

## Modules

Derived from `docs/ARCHITECTURE.md` §2's component diagram: Agreement, Verification, Payment,
Staff & Permissions, Requests (hardship/partial/settlement/dispute), Evidence & Document, Witness,
Notification, Invitation, Bulk Import, Pricing & Billing, Fraud & Risk, Admin & Appeals, Audit.

## Phase 0 — Foundations & scaffolding

**Goal:** Stand up the repository, environments, and core identity/profile schema with zero
payment or verification-provider dependency, so every later phase has something to build on.

**Features:** Project scaffolding (per `docs/ARCHITECTURE.md` §2's Next.js/TypeScript stack);
CI pipeline; `user_account`, `personal_profile`, `business_profile`, `beneficial_owner`,
`business_staff_member`, `custom_role` tables (`docs/DATA_MODEL.md` §4); basic auth
(password/passkey) without MFA-gated actions yet (those arrive with the features they gate);
Audit Service skeleton (append-only `audit_event` table, hash-chaining logic — FR-AUDIT-001–003)
wired in from day one since every later module depends on writing through it, not around it.

**Dependencies:** None — this phase requires no processor, no KYC/KYB provider, and no legal
review.

**Risks:** None from `docs/RISK_REGISTER.md` are specific to this phase; general engineering
setup risk only.

**Acceptance gate:** Repository builds, CI green, a `user_account` can be created and
authenticated, and a manually-inserted test action produces a correctly hash-chained
`audit_event` row.

**Security review gate:** Confirm NFR-SEC-002/003 (encryption at rest/in transit, secrets
management) are configured at the infrastructure level before any real data — even test data
resembling PII shape — is stored.

**Testing gate:** Unit tests for audit hash-chaining (`docs/TEST_STRATEGY.md` §1); integration test
confirming every schema write in this phase goes through the Audit Service, not around it
(`docs/TEST_STRATEGY.md` §2).

## Phase 1 — Agreement core (no payments)

**Goal:** Full draft → acknowledge → accept → sign lifecycle for P2P agreements, with amendment
versioning, but no real payment execution.

**Features:** FR-AGR-001–008, FR-FPAY-002/004 (schedule display/status progression, first-payment
*collection* deferred to Phase 2), FR-SIG-001–003, `agreement`/`agreement_version`/
`agreement_party`/`installment_schedule_item`/`signature_event` tables, Agreement lifecycle state
machine (`docs/STATE_MACHINES.md` §1) minus the payment-driven transitions.

**Dependencies:** Phase 0.

**Risks:** RISK SEC-02/SEC-03 (forged signatures, altered agreements) are directly in scope here —
this phase is where those mitigations must actually be implemented, not just designed.

**Acceptance gate:** A test agreement can be drafted, acknowledged, accepted, and signed by two
test users, producing an immutable `agreement_version` and a generated PDF (FR-SIG-002).

**Security review gate:** Confirm signed-version immutability is enforced at the database layer
(revoked `UPDATE` grant once `signed_at` is set), not only in application code — directly testable
per `docs/TEST_STRATEGY.md` §8.

**Testing gate:** Agreement immutability tests (§8), signature tests (§9), authorization tests (§6)
for the borrower-acknowledgment / creditor-acceptance separation.

## Phase 2 — Identity & business verification

**Goal:** Wire the Verification Service to a real (or, if the provider open decision is still
unresolved, a mocked-but-swappable) KYC/KYB provider, gating Phase 1's signing step behind actual
tier verification.

**Features:** FR-IDV-001–004, `identity_verification_record` table, Identity/Business verification
state machines (`docs/STATE_MACHINES.md` §8–9), age gate (FR-IDV-003).

**Dependencies:** Phase 1 (signing exists to gate); **open decision #16** (KYC/KYB provider) —
if unresolved, this phase proceeds against a mock provider behind the same interface, deferring
only the *real* integration, not the internal design.

**Risks:** RISK FIN-04 / SEC threat "Synthetic identity" (`docs/SECURITY_MODEL.md` §15) — detection
quality is provider-dependent; this phase's acceptance gate cannot fully close that risk until a
real provider is integrated.

**Acceptance gate:** A test user cannot reach the signing step from Phase 1 without completing Full
verification; an underage test identity is blocked.

**Security review gate:** Confirm no raw ID/selfie data is stored outside the Verification
Service's restricted path (NFR-PRIV-001).

**Testing gate:** Authorization tests confirming verification-tier gating (§6); row-level isolation
tests confirming verification records aren't cross-readable (§7).

## Phase 3 — Payments sandbox integration

**Goal:** Real processor integration (sandbox mode) for ACH and debit-card collection, connected
recipient accounts, and payout — this is where Roadmap Stage 3 technically happens.

**Features:** FR-PAYMETHOD-001–004, FR-ROUTE-001–003, FR-MONEY-001–003, `payment_method`,
`payment_attempt`, `payout`, `ledger_entry` tables, full Payment/Payout state machines
(`docs/PAYMENT_STATE_MACHINE.md`), webhook consumer with signature verification and dedupe.

**Dependencies:** Phase 1 (agreements to pay against), Phase 2 (verified recipients required before
a connected account can be created, `docs/PAYMENT_ARCHITECTURE.md` §3); **blocking on open decision
#3** (processor selection) — this phase cannot meaningfully start without at least a sandbox-level
processor relationship.

**Risks:** RISK SEC-04 (webhook spoofing), FIN-05 (post-payout clawback mechanics depend on the
processor chosen) are both central to this phase.

**Acceptance gate:** A test agreement's mandatory first payment clears in sandbox and triggers a
correctly balanced ledger posting (`docs/PAYMENT_ARCHITECTURE.md` §14); a simulated webhook replay
produces no duplicate state change.

**Security review gate:** Webhook signature verification is mandatory and tested adversarially
(a deliberately invalid signature must be rejected) before this phase's gate is considered passed.

**Testing gate:** Payment webhook tests (§4), idempotency tests (§5) — both explicitly named
categories in Deliverable 13, and both most critical in this exact phase.

## Phase 4 — Failed payments, retries, payouts, reconciliation

**Goal:** Complete the payment lifecycle's non-happy-path behavior and the reconciliation job.

**Features:** FR-FAIL-001–006, ACH return / chargeback / refund / reversal flows
(`docs/PAYMENT_ARCHITECTURE.md` §6–10), Scheduler jobs (installment due, automatic retry,
reconciliation — `docs/ARCHITECTURE.md` §6).

**Dependencies:** Phase 3.

**Risks:** RISK FIN-05 again (clawback mechanics), OPS-01 (no numeric target for how fast
reconciliation drift should be caught — can still be built, gate is qualitative until #11 resolves).

**Acceptance gate:** A simulated ACH return correctly reduces recorded paid balance and posts the
correct reversal ledger entries; a failed payment triggers exactly one automatic retry and stops.

**Security review gate:** Confirm failure-category mapping never leaks raw processor decline codes
to either party (NFR-SEC-008).

**Testing gate:** Full payment-lifecycle e2e tests (§3) covering the failed-payment and retry
journeys specifically (`docs/deliverables/03-user-journeys.md` Journeys 6–7).

## Phase 5 — Amendments, hardship, partial payment, settlement, dispute

**Goal:** The full counterparty-approval-request pattern and its downstream amendment/signature
flow.

**Features:** FR-HARD-*, FR-PART-*, FR-SETL-*, FR-DISP-*, FR-UPAY-*, Requests Service, Amendment
lifecycle and its four dependent request state machines (`docs/STATE_MACHINES.md` §3–7).

**Dependencies:** Phase 1 (amendment mechanics), Phase 3–4 (settlement/partial payments need real
payment execution).

**Risks:** Resolves open decisions #9/#10/#18 in practice — this phase is where the design
resolutions for witness-verification-tier and paused-by-amendment timing get implemented and should
be explicitly reconfirmed with product before coding, even though they're not Phase 0 blockers.

**Acceptance gate:** A hardship request can be submitted, countered, accepted, and results in a
correctly signed amendment that leaves the original version intact.

**Security review gate:** N/A beyond what Phase 1/3 already cover — no new attack surface class is
introduced, this phase mostly composes existing primitives.

**Testing gate:** E2E tests for Journeys 8–14 (`docs/deliverables/03-user-journeys.md`).

## Phase 6 — Evidence, witnesses, PDF/document pipeline

**Goal:** Full evidence upload/labeling, witness invitation/attestation, and the document
processing pipeline (virus scan, hash, signed URLs).

**Features:** FR-EVID-001–005, FR-WIT-001–004, `evidence_document`, `witness_attestation` tables,
Document Worker (`docs/ARCHITECTURE.md` §7).

**Dependencies:** Phase 1 (agreements to attach evidence to), Phase 2 (witness Basic-verification
gate, per the design resolution in `docs/STATE_MACHINES.md` §13).

**Risks:** RISK SEC-06 (document malware).

**Acceptance gate:** An infected test upload (EICAR test file) is rejected; a witness attestation
correctly binds to one specific `agreement_version_id` and is not carried into a later amendment.

**Security review gate:** Confirm witness access is denied to any sensitive-document endpoint by
default (FR-EVID-005) via an adversarial test, not just a UI hide.

**Testing gate:** Authorization tests for the witness boundary specifically (§6); security tests for
the malware-upload scenario (§11).

## Phase 7 — Business staff, permissions, B2B

**Goal:** Full staff role/permission model, two-person/owner approval, and the B2B-specific
authorized-representative and per-business-audit requirements.

**Features:** FR-STAFF-001–005, FR-B2B-001–010, `staff_approval_request`,
`business_staff_member.is_authorized_representative`.

**Dependencies:** Phase 1–2 (agreements + business verification), Phase 3 (B2B payout routing to
business accounts).

**Risks:** RISK SEC-09/FIN-06 (staff abuse, staff collusion) — the two-person-approval control is
implemented here; its known residual (consenting collusion) is accepted per
`docs/SECURITY_MODEL.md` §14, not something this phase can close further.

**Acceptance gate:** A staff action exceeding a configured cap is correctly queued and requires a
*different* staff member's approval (`proposed_by_staff_id <> approved_by_staff_id` enforced).

**Security review gate:** Confirm per-business audit separation (FR-B2B-007) — one business's staff
member cannot see another business's audit trail even when both are counterparties on the same B2B
agreement.

**Testing gate:** Authorization tests for every permission cap in the Deliverable 2 matrix (§6).

## Phase 8 — CSV import, invitations, notifications

**Goal:** Bulk draft creation, the full invitation lifecycle, and the critical/noncritical
notification split.

**Features:** FR-CSV-001–004, FR-INV-001–004, FR-NOTIF-001–004, Invitation and CSV Import Services.

**Dependencies:** Phase 1 (drafts to create in bulk), Phase 7 (business context for CSV imports).

**Risks:** RISK SEC threat "Invitation interception" (`docs/SECURITY_MODEL.md` §7).

**Acceptance gate:** A CSV import produces only draft agreements, never active ones, regardless of
row count; a forwarded invitation link fails for anyone but the bound contact.

**Security review gate:** Invitation single-use and expiry enforcement tested adversarially (reuse
attempt after acceptance must fail).

**Testing gate:** E2E test for Journey 16 (CSV import); load test for a large import running
alongside normal traffic (§14, per NFR-SCALE-003).

## Phase 9 — Admin, fraud, appeals, audit hardening

**Goal:** The internal administrative surface, fraud-rule engine, and appeals workflow.

**Features:** FR-ADMIN-001–003, FR-FRAUD-001–004, FR-APPEAL-001–003, Admin & Appeals Service,
Fraud & Risk Service.

**Dependencies:** Phases 1–8 (needs the full feature surface to have something to administer/flag).

**Risks:** RISK SEC-10 (administrator abuse) — directly mitigated/tested here; RISK FIN-01
(collusion) — fraud-rule patterns implemented here are the primary technical mitigation available
for that accepted residual risk.

**Acceptance gate:** An administrator account cannot alter a signed agreement even via direct API
call (adversarial test); an appeal case's reviewer is programmatically prevented from being the
original restriction's author.

**Security review gate:** Full pass through `docs/SECURITY_MODEL.md`'s threats #9, #10, #14 as
adversarial test scenarios, not just code review.

**Testing gate:** Fraud scenario tests (§12) for every FR-FRAUD-002 pattern; security tests (§11)
for administrator-boundary and appeals-separation.

## Phase 10 — Accessibility, compliance polish, beta readiness

**Goal:** Close out NFR-ACC-* and NFR-OBS-* gaps, and prepare for Roadmap Stage 4 (Closed beta).

**Features:** Full WCAG 2.2 AA pass, observability/monitoring wiring (NFR-OBS-001–003), the
consolidated final review screen polish (NFR-ACC-005).

**Dependencies:** All prior phases (this is a cross-cutting hardening phase, not new features).

**Risks:** None new — this phase exists to close residual gaps from every prior phase's testing
gates.

**Acceptance gate:** Automated accessibility scan passes on every core flow; a synthetic
webhook-failure and dead-lettered-job scenario both trigger the expected alert (NFR-OBS-002).

**Security review gate:** Full `docs/SECURITY_MODEL.md` threat-by-threat review confirming every
"Not yet reviewed" item that *can* be closed by this point (i.e., everything except
provider-dependent items still blocked by open decisions #3/#16) has been.

**Testing gate:** Accessibility tests (§10) run to completion; disaster recovery test (§13) restore
drill executed at least once, even without a numeric RTO/RPO target yet (open decision #14).

---

## Phase 0 readiness determination

**Phase 0 is ready to begin.**

Cross-checking `docs/OPEN_DECISIONS.md`'s consolidated summary and `docs/RISK_REGISTER.md` against
Phase 0's actual scope (repository scaffolding, CI, core identity/profile schema, audit-log
skeleton — explicitly *no* payments, *no* live verification, *no* MFA-gated financial actions):

- **No open decision blocks Phase 0.** All 19 items gate either a later implementation phase
  (Phase 2 onward) or a later roadmap stage (`docs/ROADMAP.md` Stage 3 onward) — none require a
  processor, a KYC/KYB provider, or legal/Sharia review to exist before scaffolding and core schema
  work can start.
- **No Risk Register item at High severity is scoped to Phase 0.** The High-severity rows (LEG-01,
  LEG-02, LEG-06, SEC-01, SEC-05, SEC-07, FIN-01, OPS-04) all attach to Phases 2–9 or Roadmap
  Stages 3–6, not to Phase 0's scaffolding work.
- **Phase 0's own acceptance/security/testing gates are fully specified above** and depend on
  nothing external — they can be met using only the schema in `docs/DATA_MODEL.md` and the
  architecture in `docs/ARCHITECTURE.md`, both already complete.

**Caveat, not a blocker:** Phase 1 (Agreement core) is also largely unblocked, but Phase 2 onward
should not begin in earnest until open decision #16 (KYC/KYB provider) has at least a working
answer (a mock-provider interface is an acceptable stopgap per Phase 2's own dependency note above),
and Phase 3 to open decision #3 (payment processor). Legal/Sharia review (`docs/ROADMAP.md` Stage 5)
should start in parallel now rather than being deferred, since its findings could affect Phase 5–7
design choices (fee structure, settlement mechanics) if raised too late.

---

**Coverage note:** This deliverable implements Section 36, Deliverable 15's required per-phase
structure (Goal/Features/Dependencies/Risks/Acceptance gate/Security review gate/Testing gate)
across 11 phases (0–10) spanning `docs/ROADMAP.md` Stages 1–3, and ends with the explicit Phase 0
readiness determination requested for this session. No application code was written.
