# Risk Register

Consolidates risk across `docs/deliverables/01-executive-summary.md` (primary legal/operational
risks), `docs/SECURITY_MODEL.md` (Deliverable 10 threats), `docs/COMPLIANCE_REVIEW_CHECKLIST.md`
(Deliverable 11), and `docs/OPEN_DECISIONS.md` into one register, satisfying the "risk register"
named alongside the PRD/architecture/data model/security model/payment-state model in the master
spec's opening paragraph. Severity is a **qualitative design-time judgment** (Low/Medium/High),
not a statistical or actuarial estimate — no probability figures are invented. This document makes
no legal or Sharia-compliance claims; see `docs/COMPLIANCE_REVIEW_CHECKLIST.md` for the disclaimer
that governs every legal/Sharia-tagged row here.

## How to read this register

Each row: **ID**, **Description**, **Severity** (qualitative), **Current mitigation / design
control**, **Residual concern**, **Linked reference**. "Mitigated" means a control is *designed*,
not implemented or verified — no application code exists yet.

## A. Legal & regulatory risk

| ID | Risk | Severity | Current mitigation (design-level) | Residual concern | Linked reference |
|---|---|---|---|---|---|
| LEG-01 | Platform is deemed a money transmitter in one or more states | High | Processor-routed, non-custodial architecture (FR-ROUTE-001) | Legal conclusion pending; no counsel review yet | Open decision #2; Compliance L1 |
| LEG-02 | Preferred payment processor declines to underwrite the business model | High | Contingency-architecture requirement acknowledged, no contingency processor selected | Entire payment architecture depends on processor approval | Open decision #3; Compliance L2 |
| LEG-03 | "Ethical, interest-free" marketing is read as an implied Sharia-compliance claim | Medium | Explicit prohibition on formal Sharia-compliance claims (§2) | No scholarly review has occurred; marketing copy not yet drafted/reviewed | Open decision #1; Compliance S1 |
| LEG-04 | Consumer-credit law applies to installment agreements despite no interest | Medium | No interest/finance charges by design | Classification is a legal question independent of fee structure | Compliance L5 |
| LEG-05 | Debt-collection statutes apply to platform-facilitated follow-up on missed payments | Medium | Positioned as neutral scribe/facilitator, not a third-party collector | Positioning itself unconfirmed by counsel | Compliance L7 |
| LEG-06 | State-by-state licensing patchwork (money transmission, debt adjusting, lending) blocks or delays launch in some states | High | Country/state fields reserved in schema for future jurisdiction logic | No state-specific licensing logic exists; national launch assumed | Compliance L8 |
| LEG-07 | Card surcharge rules are violated by the fee-allocation engine's method-switch cost pass-through | Medium | Incremental cost defaults to borrower per signed terms | Surcharge-specific disclosure/labeling mechanism not yet designed | Compliance L13 |
| LEG-08 | Payment volume triggers tax information-reporting obligations (e.g., 1099-K) with no architecture support | Medium | None yet — gap | Not represented anywhere in current architecture | **New — see open decision #19** |
| LEG-09 | OFAC/sanctions screening gap if the eventual processor/KYC-KYB provider doesn't cover it end-to-end | Medium | Assumed delegated to processor/KYC-KYB provider | Provider not yet selected; coverage unconfirmed | Open decision #16; Compliance L16 |

## B. Security risk

| ID | Risk | Severity | Current mitigation (design-level) | Residual concern | Linked reference |
|---|---|---|---|---|---|
| SEC-01 | Account takeover leading to unauthorized signing or payout redirection | High | MFA, session hygiene, device monitoring | SMS-fallback / social-engineering bypass | Security Model §1, §16 |
| SEC-02 | Forged signature or repudiated signature dispute | High | Authenticated session, fresh step-up/MFA, agreement-party and signing-authority authorization, full signature-event capture, tamper-evident hashing (none require full KYC/KYB) | Account-recovery / session-compromise risk (see SEC-01) | Security Model §2 |
| SEC-03 | Signed agreement altered outside the amendment flow | Medium | DB-level immutability, admin prohibition, hash-chained audit | DB/infra superuser access control (ops-level, out of app scope) | Security Model §3 |
| SEC-04 | Webhook spoofing triggers a false payment/payout state | Medium | Mandatory signature verification, state-machine enforcement | Depends on signing-secret hygiene | Security Model §4 |
| SEC-05 | Cross-tenant data leakage between unrelated users/businesses | High | Dual-layer authorization (RLS + app layer) | New-endpoint implementation gaps at build time | Security Model §11 |
| SEC-06 | Document-upload malware | Low | Mandatory virus scanning | Zero-day evasion | Security Model §8 |
| SEC-07 | Payout redirection via unauthorized bank/payout-detail change | High | Elevated MFA, critical non-disableable notification, full audit trail | Depends on account holder noticing/acting on the alert promptly | Security Model §16 |

## C. Fraud & financial risk

| ID | Risk | Severity | Current mitigation (design-level) | Residual concern | Linked reference |
|---|---|---|---|---|---|
| FIN-01 | Collusion between two consenting parties (including staff) to fabricate or manipulate agreements | High | Fraud-pattern flags (collusive agreements, circular activity, shared bank/device) | **Accepted residual — inherently a detection/investigation problem, not preventable by design** | Security Model §14 |
| FIN-02 | Fraudulent debt creation naming an uninvolved real person | Medium | Mandatory independent borrower authentication/acknowledgment | Cannot prevent two colluding verified identities (see FIN-01) | Security Model §13 |
| FIN-03 | Business activity deliberately routed through a personal profile to evade classification/pricing | Medium | Multi-signal classification (declaration + verification + account matching + risk review) | Policy-level control, not a hard technical prevention | Security Model §12 |
| FIN-04 | Synthetic identity passes KYC/KYB | Medium | Tiered verification, duplicate-identity fraud flags | Detection quality is provider-dependent | Security Model §15; Open decision #16 |
| FIN-05 | Post-payout ACH return/chargeback clawback mechanics are processor-dependent and not fully specified | Medium | Connect-style model intends risk to sit with the creditor's connected account, not PAY2PAY (§7) | Exact recourse mechanics depend on final processor selection | `docs/PAYMENT_ARCHITECTURE.md` §3, §14; Open decision #3 |
| FIN-06 | Staff two-person approval defeated by staff collusion | Medium | `staff_approval_request` proposer≠approver constraint | Same as FIN-01 — technical control cannot fully prevent consenting collusion | Security Model §9 |

## D. Operational / architectural risk

| ID | Risk | Severity | Current mitigation (design-level) | Residual concern | Linked reference |
|---|---|---|---|---|---|
| OPS-01 | No numeric performance, availability, or scale targets to design/test against | Medium | Qualitative NFRs written; architecture designed for horizontal scalability in principle | Cannot size infrastructure or set SLOs concretely until targets are set | Open decisions #11–13 |
| OPS-02 | No RTO/RPO defined for disaster recovery | Medium | Backup/restore-drill requirement stated qualitatively | Cannot select a concrete backup cadence/replication strategy yet | Open decision #14 |
| OPS-03 | Backup lifecycle may not correctly honor legal holds / retention / data-minimization simultaneously | Medium | Retention/legal-hold fields modeled at the row level | Backup-tooling-level reconciliation mechanism not yet designed | Open decision #15 |
| OPS-04 | No identity/business verification (KYC/KYB) provider selected | High | Verification Service abstracts the provider behind a stable internal interface | Blocks finalizing Identity/Business verification state machines' real-world timing and Synthetic-identity risk (FIN-04) | Open decision #16 |
| OPS-05 | Post-close payment reversal has no defined agreement-status effect | Low | Current model treats Paid-in-full/Settled-in-full as non-reverting | Genuine gap requiring a business decision | Open decision #17 |

## E. Product / policy risk

| ID | Risk | Severity | Current mitigation (design-level) | Residual concern | Linked reference |
|---|---|---|---|---|---|
| PRD-01 | Compliance-reviewer vs. platform-administrator authority boundary is undefined | Low | Modeled as distinct roles satisfying appeals separation-of-duties | Exact authority split needs product/compliance sign-off | Open decision #5 |
| PRD-02 | Support-agent vs. compliance-reviewer escalation path is undefined | Low | N/A | Needs product decision | Open decision #6 |
| PRD-03 | B2B dual-pricing allocation (both businesses paid tier) has no default | Low | Configurable pricing tables (no hard-coded default) | Needs a product/pricing decision before launch pricing is set | Open decision #4 |
| PRD-04 | Witness verification tier (Basic vs. Full) is a design assumption, not a confirmed rule | Low | Basic verification required, as a working assumption | Needs product/legal confirmation | Open decision #9/#18 |
| PRD-05 | "Paused by amendment" trigger timing is a design assumption, not a confirmed rule | Low | Agreement stays Active/Past due through negotiation, pauses only on signed pause term | Needs product confirmation before implementation | Open decision #10/#18 |
| PRD-06 | Sharia-review governance (which scholar/body, which standard) is undecided | Medium | N/A | Blocks all Sharia-review checklist items (S1–S6) from proceeding | Compliance S7 |

---

**Highest-severity items requiring attention before implementation begins:** LEG-01/LEG-02 (money
transmission classification and processor underwriting — existential to the business model),
LEG-06 (state licensing), SEC-01/SEC-05/SEC-07 (account takeover, cross-tenant leakage, payout
redirection — the three highest-impact technical attack surfaces), FIN-01 (collusion, accepted
residual requiring an ongoing fraud-operations function, not a one-time design fix), and OPS-04
(KYC/KYB provider selection, which blocks finalizing several other rows).

**Coverage note:** This register consolidates every risk-bearing item surfaced across Deliverables
1 and 9–11 plus the full open-decisions log into one prioritized view. It introduces no new risks
beyond LEG-08/OPS gap already logged as open decision #19 below.

*See `docs/OPEN_DECISIONS.md` for the full narrative log this register draws from.*
