# Sprint Requirements Matrix

Maps each of the 20 sprint files in `docs/sprints/` to the master-spec section(s) and
requirement ID(s) (from `docs/REQUIREMENTS_TRACEABILITY_MATRIX.md`) it implements. Built by
reading all 20 sprint files in full against `docs/PAY2PAY_MASTER_SPEC.md` and the existing
traceability matrix — not assumed from sprint titles alone.

**Revision 2** — updated after the repair pass that closed the identity-verification, MFA, and
pricing gaps identified in Revision 1 (superseded rows marked below where scope changed).

| Sprint | Primary scope | Master-spec section(s) | Requirement ID(s) | Coverage note |
|---|---|---|---|---|
| 1 — Public Preview/Vercel Readiness | Deployment readiness, early-access lead capture | §33 (technical expectations), §37 (no false claims) | NFR-SEC-* (secrets/bundle) | Early-access lead capture is not itself a master-spec FR; it's pre-MVP marketing infrastructure. |
| 2 — Authentication | Signup/login/session, base personal+business profile relationship, **MFA/step-up primitive** | §17 (basic tier only), §18 (base relationship only), **§26 (MFA — new)** | FR-IDV-001 (basic tier only), FR-PROF-001 (base model only), **FR-MFA-001–002 (new)** | **Changed:** now owns `requireStepUp(user, action)`, called by Sprints 4, 6, and 15. |
| 3 — Personal & Business Profiles | Full profile fields, profile switcher, dashboards, **identity-verification architecture (tiers/state model/gating interface)**, **pricing/account-plan architecture** | §18, §18A, **§17 (architecture — new)**, **§19 (new)** | FR-PROF-001–004, FR-B2B (profile fields only), **FR-IDV-001–004 (architecture; new)**, **FR-PRICE-001–006 (new)** | **Changed:** owns `isFullyVerified(profile)` (consumed by Sprints 6 and 9) and the pricing-table data model. Real KYC/KYB provider wiring is Sprint 9's job, not this sprint's — see below. Sprint 12 was originally planned to consume this pricing-table model for its fee-reallocation rule; Sprint 12's actual implementation instead reads Sprint 5's `feeAllocation` term — see row 12's note. |
| 4 — Business Staff/Permissions | RBAC, capabilities, approval thresholds, dual approval | §20 | FR-STAFF-001–005 | **Changed:** "elevated authentication hooks" now explicitly calls Sprint 2's `requireStepUp` — no longer an unresolved reference. |
| 5 — Agreement Engine | Core agreement lifecycle/state machine, schedule calc, versioning | §3, §4, §5 (placeholder only) | FR-AGR-001–008 | Unchanged. Declares states consumed by later sprints (SETTLED_IN_FULL, DISPUTED, PAUSED_BY_AMENDMENT). |
| 6 — Electronic Signatures/PDF | Signing, PDF generation, hashing | §27 | FR-SIG-001–003 | **Changed:** signing gate now explicitly calls Sprint 2's `requireStepUp` and Sprint 3's `isFullyVerified` — both dependencies precede Sprint 6 in sequence, so this is buildable, not a forward reference. |
| 7 — Evidence/Witnesses | Evidence upload, witness model | §15, §16 | FR-EVID-001–005, FR-WIT-001–004 | Unchanged. Depends on Sprints 5 and 6. |
| 8 — B2B Workflows/CSV Import | B2B agreement flow, bulk draft import | §18A, §21 | FR-B2B-001–010, FR-CSV-001–004 | Unchanged. Depends on Sprints 3, 4, 5. |
| 9 — Payment Provider Abstraction/Sandbox | Provider-independent payment interfaces, webhook handling, **KYC/KYB provider integration (additive, separate interface)** | §6, **§17 (provider integration — new)** | FR-PAYMETHOD-001–004, **FR-IDV-001–004 (integration; new)** | **Changed:** payment-abstraction scope kept intact per instruction; KYC/KYB integration added as a second, non-merged interface that fulfills Sprint 3's verification state model. The payment abstraction's "create payment" entry point now also enforces `isFullyVerified` for payer and recipient — enforced once here, not per adapter. |
| 10 — Internal Ledger | Double-entry ledger, reconciliation foundation | §7 | FR-ROUTE-001–003 (partial), FR-MONEY-001–003 (§37) | Unchanged. Sequenced after Sprint 9, before Sprints 11–12. |
| 11 — ACH Sandbox | ACH-specific lifecycle, mandate, ledger postings | §6–8 | FR-PAYMETHOD, FR-ROUTE, FR-FAIL (raw states only) | Unchanged. Verification gate is enforced upstream in Sprint 9's abstraction, not re-implemented here. Dispute-adjacent test scenario still only needs the raw `DISPUTED` state ahead of Sprint 16 — sequencing note, not a conflict. |
| 12 — Debit Card Sandbox | Card-specific lifecycle, ACH-vs-card fee reallocation | §6–8 | FR-PAYMETHOD, FR-PRICE (partial — see note) | **Changed (implementation correction):** built against Sprint 5's `agreement_version.feeAllocation` term, not Sprint 3's §19 pricing-table model — §19's `pricing_plan`/`subscription` tables are business-subscription fees (`docs/PAYMENT_ARCHITECTURE.md` §4: "architecturally separate"), not a per-payment processor-fee rate source, so there was nothing there for a method-switch surcharge rule to read. This row and row 3's "pricing-table data model (consumed by Sprint 12)" note were both inaccurate — corrected during Sprint 12's implementation, not merely planned. `docs/PAYMENT_ARCHITECTURE.md` §2 and `docs/SPRINT_CONTROL.md`'s "Sprint 12 implementation notes" have the full detail. |
| 13 — Failed Payments/Retry | Cross-cutting retry/notify/reschedule workflow | §8 | FR-FAIL-001–006 | Unchanged. Still requires "Notify both parties" before Sprint 17 exists — see Sequencing risk 1 in `docs/SPRINT_CONTROL.md` (open; lower severity than the resolved items). |
| 14 — Amendments/Hardship | Agreement modification and hardship workflow | §9; folds into §3 general principles + Sprint 5's `PAUSED_BY_AMENDMENT` | FR-HARD-001–004 | Unchanged. |
| 15 — Partial Payments/Settlement | Partial-payment and settlement workflow | §11, §12, **§26 (MFA — new)** | FR-PART-001–004, FR-SETL-001–004, **FR-MFA (settlement approval; new)** | **Changed:** settlement approval now explicitly calls Sprint 2's `requireStepUp` — no longer an unresolved reference. |
| 16 — Disputes | Agreement disputes + payment disputes (two distinct systems) | §13, §14 | FR-DISP-001–006, FR-UPAY-001–006 | Unchanged. Owns the dispute *system*; Sprints 11/12 only needed the raw state ahead of this. |
| 17 — Notifications | Notification infrastructure (email/SMS/in-app) | §23 | FR-NOTIF-001–004 | Unchanged. Still the latest-built consumer of events referenced by 5, 6, 8, 13, 14, 15, 16 — see Sequencing risk 1 (open). |
| 18 — Admin/Support/Appeals | Internal ops roles, restrictions, appeals, **retention/legal holds** | §29, §30, **§28 (new)** | FR-ADMIN-001–003, FR-APPEAL-001–003, **FR-RET-001–003 (holds; new)** | **Changed:** now owns retention hold / dispute hold / fraud-review hold / litigation hold, with audit trail and deletion-blocking behavior. "Review verification status" now resolves against Sprint 3's real state model rather than an undefined placeholder. |
| 19 — Fraud/Risk/Security Hardening | Fraud indicators, app security testing | §31, §33 | FR-FRAUD-001–004, NFR-SEC-* | Unchanged. "Additional verification" now resolves against Sprint 3/9's real verification system. Correctly placed late. |
| 20 — Closed Beta Readiness | Ops/observability/staging, go/no-go gate, **retention/deletion/hold verification** | §33, §36, §37, **§28 (new)** | NFR-PERF-*, NFR-REL-*, NFR-SCALE-*, **FR-RET-001–003 / NFR-RET-001–002 (verification; new)** | **Changed:** acceptance requirements now include seven-year retention behavior, deletion/minimization testing, retention-hold end-to-end testing, and a restore drill covering held records. |

## Remaining gaps (not addressed by this repair pass)

| Master-spec section | Requirement ID(s) | Status | Severity |
|---|---|---|---|
| §23 Notifications built late relative to consumers (Sprints 5, 6, 8, 13, 14, 15, 16 all reference "notify" before Sprint 17 exists) | FR-NOTIF-001–004 | Open — not in this repair's instruction list | Medium — see Sequencing risk 1, `docs/SPRINT_CONTROL.md` |

## Resolved in this repair pass

- §17 Identity verification (full tier) — architecture owned by Sprint 3, provider integration
  owned by Sprint 9, consumed by Sprints 6 and 9's payment-creation gate.
- §26 Multifactor authentication — primitive owned by Sprint 2, consumed by Sprints 4, 6, 15.
- §19 Pricing logic — architecture owned by Sprint 3, consumed by Sprint 12.
- §28 Data retention — operational holds owned by Sprint 18, verified at the Sprint 20 gate.

Deliberately out of scope and correctly *not* covered by any sprint (matches
`docs/deliverables/01-executive-summary.md` MVP Boundaries): §24 Internal communication/chat
(Sprint 17 explicitly excludes it), §25 Credit reporting.
