# Deliverable 12: Product Roadmap

Source: `docs/PAY2PAY_MASTER_SPEC.md`, Section 36 Deliverable 12, which names nine stages to keep
separate. This is a **business/product-level** roadmap; the module-by-module technical breakdown
within and across these stages is `docs/IMPLEMENTATION_PLAN.md` (Deliverable 15). Nothing here
implies a specific calendar date — no launch date is fixed, since several stages are gated on
external decisions (processor approval, legal review) outside PAY2PAY's own control.

## Stage 1: Prototype

**Goal:** Validate the core agreement-creation-through-signature experience with no real money
movement, to test whether the plain-language, non-sophisticated-user experience (NFR-ACC-*) and the
core agreement data model actually hold up with real users.

**Scope:** Draft → acknowledge → accept → sign flow (P2P only), the mandatory final review screen
(NFR-ACC-005), agreement PDF generation. Payments are simulated/stubbed, not real.

**Exit criteria:** Usability-tested signing flow meets WCAG 2.2 AA baseline (NFR-ACC-001) and plain-
language comprehension goals; core `agreement`/`agreement_version` data model validated against
real test agreements.

**Gating risks:** None blocking — this stage requires no processor, no KYC/KYB provider, and no
legal review to begin.

## Stage 2: MVP foundation

**Goal:** Build the full non-payment agreement lifecycle for all four relationship shapes
(P2P/B2C/C2B/B2B), identity/business verification, staff/permissions, evidence, witnesses, and the
audit trail — everything except live money movement.

**Scope:** FR-AGR-*, FR-IDV-*, FR-PROF-*, FR-B2B-*, FR-STAFF-*, FR-EVID-*, FR-WIT-*, FR-SIG-*,
FR-AUDIT-*, FR-INV-*, FR-NOTIF-* (see `docs/REQUIREMENTS_TRACEABILITY_MATRIX.md` for full mapping).

**Exit criteria:** An agreement can be fully created, verified, signed, amended, and audited
end-to-end with no payment ever executed; row-level tenant isolation and immutability tests pass
(`docs/TEST_STRATEGY.md`).

**Gating risks:** RISK OPS-04 (KYC/KYB provider not selected) blocks the *real* verification
integration but not the Verification Service's internal interface/state machine, which can be built
against a mock provider first.

## Stage 3: Payments sandbox

**Goal:** Integrate a payment processor in test/sandbox mode — ACH and debit-card flows, webhooks,
idempotency, payout, ledger, reconciliation — with no real funds moving.

**Scope:** FR-PAYMETHOD-*, FR-ROUTE-*, FR-FAIL-*, FR-MONEY-*, all of `docs/PAYMENT_ARCHITECTURE.md`
and `docs/PAYMENT_STATE_MACHINE.md`.

**Exit criteria:** Full payment/payout state machine exercised against the processor's sandbox,
including simulated failures, ACH returns, and chargebacks; reconciliation job correctly detects
injected drift; idempotency tests pass under simulated retries/duplicate webhooks.

**Gating risks:** **Blocking** — RISK LEG-02 / open decision #3 (no processor has confirmed
underwriting approval of this business model). This stage cannot begin in earnest until a processor
is selected and at minimum sandbox-approved; a contingency processor should be identified per the
spec's explicit instruction even before that approval is final.

## Stage 4: Closed beta

**Goal:** Real users, real (small-value) money movement, invitation-only, single or few U.S. states,
to validate the full lifecycle (hardship, partial payment, settlement, disputes, appeals) under real
conditions before wider exposure.

**Scope:** Everything in Stages 1–3 plus FR-HARD-*, FR-PART-*, FR-SETL-*, FR-DISP-*, FR-UPAY-*,
FR-APPEAL-*, FR-FRAUD-* live (not simulated).

**Exit criteria:** A cohort of real agreements reaches Paid-in-full/Settled-in-full through the real
payment rail; fraud/risk flags fire correctly against real (if limited) traffic; no unresolved
Critical/High security-model residual risk remains unmitigated for the features live in this stage.

**Gating risks:** RISK SEC-01/05/07 (account takeover, cross-tenant leakage, payout redirection)
must have passed security testing (`docs/TEST_STRATEGY.md` §11) before any real money is at stake,
even at small scale.

## Stage 5: Legal and compliance validation

**Goal:** Resolve the `docs/COMPLIANCE_REVIEW_CHECKLIST.md` items with qualified counsel (and, for
the Sharia-review items, qualified scholarly review) before any public claim or broader launch.

**Scope:** All L1–L17 legal items and S1–S7 Sharia items; state-licensing determination (L8) in
particular may itself gate *which* states closed beta / production pilot can include.

**Exit criteria:** Money-transmission classification (LEG-01), processor/agent structure (LEG-02),
and state-licensing scope (LEG-06) are resolved with counsel; Sharia-review governance (PRD-06) is
decided and, if pursued, the S1–S6 review is underway or complete before any "ethical, interest-free"
marketing claim goes live publicly.

**Gating risks:** This stage is not strictly sequential after Closed beta — legal/compliance
validation should start in parallel with Stage 2/3, since its findings (e.g., a state being
excluded, or a fee-structure change from Sharia review) could require rework in earlier stages if
deferred too late. It is listed as its own stage per the spec's explicit separation, but the
*timing* is deliberately overlapping, not strictly sequential.

**No legal or Sharia-compliance claim is made by this roadmap or any other project document** — this
stage's exit criteria are about completing the review, not asserting an outcome.

## Stage 6: Production pilot

**Goal:** Limited-scale live launch in the state(s) cleared by Stage 5, with full monitoring,
reconciliation, and support operations running for real.

**Scope:** Everything, at limited scale; Observability NFRs (NFR-OBS-*) and Disaster-recovery NFRs
(NFR-DR-*) must be operating, not just designed.

**Exit criteria:** Reconciliation exceptions trend to zero/near-zero over a sustained window;
support/appeals process (FR-APPEAL-*) has handled real cases; no unresolved Critical-severity Risk
Register item remains open.

**Gating risks:** RISK OPS-01/02 (no numeric performance/availability/scale targets, no RTO/RPO) —
these should be set with real pilot data informing them, but a working numeric target must exist
before declaring the pilot itself successful, not left permanently qualitative.

## Stage 7: Public U.S. launch

**Goal:** Remove the invitation-only/limited-state gating from Stage 6 and open registration
broadly across cleared U.S. states.

**Scope:** Same feature set as Stage 6; the change is exposure/scale, not new functionality.

**Exit criteria:** State-licensing scope from Stage 5 is finalized for the launch footprint;
infrastructure has been load-tested (`docs/TEST_STRATEGY.md` §14) against realistic projected
volume once a scale target exists (resolving open decision #13).

## Stage 8: Post-launch features

**Goal:** The explicitly deferred-but-designed-for capabilities: structured in-agreement messaging
(§24), credit-bureau reporting (§25, FR-CREDIT-002's reserved fields), faster/instant payout
(§7), accounting integrations beyond CSV (FR-CSV-004's abstraction layer), native mobile apps.

**Scope:** Deliberately excluded from MVP (`docs/deliverables/01-executive-summary.md`, MVP
Boundaries) but explicitly designed to be addable without rearchitecture.

**Exit criteria:** Each post-launch feature gets its own scoped deliverable when undertaken — this
roadmap only confirms the architecture doesn't block them, not that they're scheduled.

## Stage 9: International expansion

**Goal:** Activate the country/currency/timezone/locale fields already reserved throughout the data
model (`docs/DATA_MODEL.md` §4) for a market beyond U.S./USD.

**Scope:** Out of scope for any stage above; requires its own jurisdiction-specific legal/compliance
validation (Stage 5 equivalent) per target country, its own payment-rail integration, and likely its
own Sharia-review considerations if marketed similarly abroad.

**Exit criteria:** Not defined by this roadmap — this stage is acknowledged as a reserved
architectural capability, not a planned near-term initiative.

---

**Coverage note:** All nine stages named in Section 36, Deliverable 12, are addressed above, each
with an explicit exit criterion and its gating risks/open decisions cross-referenced to
`docs/RISK_REGISTER.md` and `docs/OPEN_DECISIONS.md` rather than treated as pre-resolved.

*Companion: `docs/IMPLEMENTATION_PLAN.md` for the technical phase-by-phase breakdown that occurs
primarily within Stages 1–3 above.*
