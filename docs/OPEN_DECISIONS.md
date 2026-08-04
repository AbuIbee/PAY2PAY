# Deliverable 14: Open Decisions

Unresolved matters identified while producing Deliverables 1–13 and `docs/ARCHITECTURE.md`,
`docs/DATA_MODEL.md`, `docs/STATE_MACHINES.md`, `docs/PAYMENT_ARCHITECTURE.md`,
`docs/PAYMENT_STATE_MACHINE.md`, `docs/SECURITY_MODEL.md`,
`docs/COMPLIANCE_REVIEW_CHECKLIST.md`, and `docs/RISK_REGISTER.md` — preserved rather than
silently decided, per `CLAUDE.md` rule 5 and master spec Section 36 (Deliverable 14: "List all
remaining decisions that must be resolved before coding or production. Do not ask broad questions
already answered in this specification"). Every item below is a genuine gap the spec leaves open,
not a restatement of something the spec already answers.

## Consolidated summary (this section is the Deliverable 14 deliverable itself)

19 open decisions accumulated across Phases 1–10. Grouped by category, with a **blocking** flag for
whether the item must be resolved before `docs/IMPLEMENTATION_PLAN.md`'s Phase 0 can begin, versus
before a *later* phase/roadmap stage.

### Legal / regulatory (must resolve before Stage 3+ in `docs/ROADMAP.md`, not before Phase 0)

| # | Decision | Blocking Phase 0? |
|---|---|---|
| 1 | "Ethical, interest-free" marketing vs. no-Sharia-claim tension | No — marketing/legal, not engineering |
| 2 | Money-transmission licensing posture | No — but blocks Stage 3 (Payments sandbox) and beyond |
| 3 | Payment-provider underwriting risk / no processor selected | **Yes for any payment-integration work**; no for Phase 0 scaffolding |
| 16 | No KYC/KYB provider named | Same as #3 — blocks real verification integration, not the Verification Service's internal interface |
| 19 | Tax information-reporting not represented in architecture | No — needed before Stage 6 (Production pilot) at the latest |

### Product / policy (should resolve before the relevant feature's implementation phase)

| # | Decision | Blocking Phase 0? |
|---|---|---|
| 4 | B2B dual-pricing allocation default | No — needed before Pricing & Billing Service implementation |
| 5 | Compliance-reviewer vs. administrator authority boundary | No — needed before Admin & Appeals Service implementation |
| 6 | Support-agent vs. compliance-reviewer escalation path | No — same phase as #5 |
| 7 | Receivables-staff default permission set | No — needed before Staff & Permissions Service implementation |
| 8 | Custom-role ceiling enforcement mechanics | No — same phase as #7 |
| 9 / 18 | Witness verification tier (design resolution: Basic) | No — needed before Witness Service implementation; a working assumption already exists |
| 10 / 18 | "Paused by amendment" trigger timing (design resolution given) | No — needed before Requests Service implementation; a working assumption already exists |
| 17 | Post-close payment reversal reopening behavior | No — needed before Payment Service handles this edge case; rare-path, can follow after MVP payment core |

### Technical / architectural (numeric targets — should resolve before the phase that needs the number)

| # | Decision | Blocking Phase 0? |
|---|---|---|
| 11 | No numeric performance targets | No — needed before load testing (Test Strategy §14), not before scaffolding |
| 12 | No numeric availability SLA | No — same timing as #11 |
| 13 | No concrete scale targets | No — same timing as #11 |
| 14 | No RTO/RPO for disaster recovery | No — needed before DR testing (Test Strategy §13), not before scaffolding |
| 15 | Backup lifecycle vs. retention/legal-hold reconciliation | No — needed before production backup tooling is configured (Stage 6) |

**Net effect on Phase 0 readiness:** none of the 19 open decisions block Phase 0 as scoped in
`docs/IMPLEMENTATION_PLAN.md` (repository scaffolding, CI, core identity/profile schema, no
payments, no live verification). Every blocking item gates a *later* phase or roadmap stage, not
the starting point. See `docs/IMPLEMENTATION_PLAN.md`'s final section for the explicit readiness
determination this consolidation feeds.

## Detailed log (chronological, by phase — preserved for provenance)

### From Phase 1 (Deliverable 1: Executive Product Summary)

1. **"Ethical, interest-free" marketing claim vs. Sharia-compliance disclaimer.** The spec (Section 2) requires marketing the platform broadly as "ethical, interest-free" while simultaneously prohibiting any claim of formal Sharia compliance until scholarly review. Marketing copy and UI language will need legal/scholarly sign-off to ensure "ethical, interest-free" framing doesn't function as an implied Sharia-compliance claim. Carried forward to Deliverable 11 (Compliance checklist) and Deliverable 14.

2. **Money-transmission licensing posture is not yet determined.** The spec asserts the platform "is not a lender," "does not advance funds," and "does not intentionally hold customer funds," which points toward a payment-facilitator/agent-of-payee model (e.g., Stripe Connect) rather than a money-transmitter model — but this is an architectural intent, not a legal conclusion. Requires qualified U.S. fintech counsel review before any launch decision. Carried forward to Deliverable 11.

3. **Payment-provider underwriting risk for this business model is unresolved.** Section 6 explicitly instructs not to assume provider approval (debt-repayment / installment-collection use cases can draw extra underwriting scrutiny from processors) and to document a contingency architecture if a preferred provider declines. No contingency provider has been selected yet. Carried forward to Deliverable 9 (Payment architecture) and Deliverable 11.

4. **B2B pricing allocation when both businesses are paid-tier customers is unresolved.** Section 18A notes pricing must be "configurable if both businesses are charged for premium business functionality" but does not specify the default allocation. Carried forward to Deliverable 19-related work (pricing tables) and Deliverable 4 (functional requirements).

### From Phase 2 (Deliverable 2: User Roles and Permissions Matrix)

5. **"Compliance reviewer" role boundary is not defined in the spec body.** It appears only in the
   Section 36 deliverable list. It was modeled as a role distinct from Platform administrator, to
   satisfy Section 30's requirement that the original decision-maker not be the sole appeal
   reviewer — but its exact authority (can it independently apply restrictions, or only
   recommend?) is an inference, not a stated rule. Needs product/compliance sign-off. Carried
   forward to Deliverable 4 (functional requirements) and Deliverable 29-related work.

6. **Support agent vs. Compliance reviewer escalation boundary is unresolved.** The spec does not
   specify whether a support agent can escalate a case directly to administrator action or must
   always route through a compliance reviewer. Carried forward to Deliverable 4.

7. **Receivables staff default permission set is unspecified.** Section 20 names the role but
   leaves its default capabilities to business configuration rather than prescribing a baseline.
   Not necessarily a gap to fix (the spec may intend full configurability), but worth confirming
   whether a sensible out-of-the-box default is desired for businesses that don't customize roles.
   Carried forward to Deliverable 4.

8. **Custom role ceiling enforcement mechanics are unspecified.** Section 20 allows owner-defined
   custom roles but does not state whether a custom role (or even a Business manager) can be
   granted permissions exceeding what the owner delegating them currently holds themselves, or how
   ceiling inheritance should work if an owner's own limits later change. Carried forward to
   Deliverable 4 and Deliverable 7 (data model — permission representation).

### From Phase 3 (Deliverable 3: Complete User Journeys)

9. **Witness identity-verification tier is unspecified.** Section 16 defines what witnesses may and
   may not do but never states whether a witness must complete Basic or Full verification before
   attesting. Since witnesses never see banking/ID data, Full verification may be unnecessary, but
   some verification tier likely matters for the attestation to carry evidentiary weight. Carried
   forward to Deliverable 4 and Deliverable 8 (state machines).

10. **State-machine placement of in-negotiation hardship/partial-payment/settlement requests is
    unspecified.** The spec defines a "Paused by amendment" agreement status (Section 5) but does
    not say precisely when an agreement enters that status during a hardship, partial-payment, or
    settlement negotiation versus remaining Active or Past due while the request is pending. Carried
    forward to Deliverable 8 (state machines), where this needs an explicit transition rule.

### From Phase 5 (Deliverable 5: Nonfunctional Requirements)

11. **No numeric performance targets specified.** The spec requires the app to work well across all
    named device classes (§1) but states no latency budget, page-load target, or API response-time
    SLO. Needs a product/engineering decision before Deliverable 13 (test strategy) can define
    performance test thresholds.

12. **No numeric availability SLA specified.** No uptime target (e.g., 99.9%) is stated anywhere in
    the spec, despite the platform handling date-bound scheduled payments. Needs a business decision,
    likely influenced by the eventual payment-processor's own SLA.

13. **No concrete scale targets specified.** The spec gives no expected volume (agreements/month,
    concurrent users, CSV row-count ceiling per import) to size the architecture against. Needed
    before Deliverable 6 (system architecture) can make concrete infrastructure-sizing
    recommendations rather than only qualitative ones.

14. **No RTO/RPO specified for disaster recovery.** Section 33 requires "backup and disaster
    recovery" but gives no Recovery Time Objective or Recovery Point Objective. Needed before
    Deliverable 6 can recommend a specific backup cadence/replication strategy.

15. **Backup lifecycle reconciliation with the seven-year retention policy and data-minimization
    deletion is unspecified.** The spec states the retention rule (Section 28) and the backup
    requirement (Section 33) independently, but not how backup purge scheduling should honor both
    an active legal hold and a data-minimization deletion request simultaneously. Carried forward
    to Deliverable 6 and Deliverable 7 (data model retention fields). **Status: still unresolved**
    after Deliverables 6–8 — `docs/DATA_MODEL.md` §8 restates the gap; no backup-tooling decision
    has been made yet.

### From Phase 6-8 (Deliverables 6-8: System Architecture, Data Model, State Machines)

16. **No identity/business verification (KYC/KYB) provider is named.** Section 6 names candidate
    payment-side providers (Stripe Connect, Stripe ACH Direct Debit, Stripe Financial Connections,
    Plaid Link/Transfer) but Section 17's identity/business verification requirements name no
    vendor at all — it's unclear whether KYC/KYB is expected to be bundled with the eventual
    payment processor (e.g., Stripe Identity) or sourced from a separate provider (e.g., Persona,
    Onfido). This affects `docs/ARCHITECTURE.md` §1's external-services list and the
    `identity_verification_record.provider_ref` field in `docs/DATA_MODEL.md` §4. Needs a
    product/engineering decision, likely alongside open decision #3 (payment-processor selection).

17. **Post-close payment reversal does not have a defined agreement-status effect.** FR-UPAY-005
    says a reversed payment reduces the agreement's recorded paid balance, but the master spec never
    addresses what happens if that reversal occurs *after* the agreement has already reached
    `Paid in full` or `Settled in full` and moved toward `Closed`. Surfaced while building the
    Agreement lifecycle state machine (`docs/STATE_MACHINES.md` §1) — the model currently treats
    those statuses as not reverting to `Active`, but this is a gap, not a spec-stated rule. Needs a
    business decision: does the agreement reopen, or is the shortfall handled as an
    out-of-band adjustment/write-off against a closed agreement?

18. **Two prior open decisions were given working design resolutions to make the state machines
    usable, but remain open pending confirmation:**
    - **#9 (witness verification tier)** — `docs/STATE_MACHINES.md` §13 now requires Basic
      verification (not Full) as a precondition for a witness to attest, on the reasoning that
      attestation is an authenticated in-app action rather than a funds/ID-handling action. Not a
      spec-stated rule.
    - **#10 (when "Paused by amendment" triggers)** — `docs/STATE_MACHINES.md` §1 now models the
      agreement as staying in its current status (`Active`/`Past due`) throughout hardship/partial/
      settlement *negotiation*, and only entering `Paused by amendment` once a **signed** amendment
      with an explicit pause term takes effect. Consistent with FR-HARD-003 but still a design
      choice, not a spec-stated rule.
    Both should be explicitly confirmed (or overridden) before implementation begins.

### From Phase 10 (Deliverables 9–11: Payment Architecture promotion, Security Model, Compliance Checklist, Risk Register)

19. **Tax information-reporting (e.g., 1099-K) is not represented anywhere in the architecture.**
    Payment volume flowing through the platform may trigger information-reporting obligations for
    recipients (typically the responsibility of whichever entity is deemed the "payment settlement
    entity" under U.S. tax rules). The master spec's compliance checklist item (§36, Deliverable 11)
    names "tax reporting" as a review item, but no functional or data-model requirement currently
    captures recipient TIN collection, reporting thresholds, or 1099 generation. This is a genuine
    architecture gap, not just a pending legal-review question — surfaced while building
    `docs/COMPLIANCE_REVIEW_CHECKLIST.md` (item L15) and logged in `docs/RISK_REGISTER.md` (LEG-08).
    Needs both a legal determination (who is the reporting entity — PAY2PAY or the payment
    processor?) and, once determined, a data-model/architecture update if PAY2PAY turns out to bear
    that obligation.

**Deliverable 9 note:** `docs/deliverables/09-payment-architecture.md` has been superseded — its
content now lives at `docs/PAYMENT_ARCHITECTURE.md` (canonical) with a new companion,
`docs/PAYMENT_STATE_MACHINE.md`. The old path is a redirect stub only.
