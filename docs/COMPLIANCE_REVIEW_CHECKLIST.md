# Deliverable 11: Compliance and Legal-Review Checklist

Source: `docs/PAY2PAY_MASTER_SPEC.md`, Section 36 Deliverable 11 and Section 37 ("do not invent
legal compliance... do not claim the platform is licensed, compliant, certified, or
Sharia-approved").

**This document makes no legal or Sharia-compliance claims of any kind.** Every item below is
phrased as a question requiring qualified review, not as a conclusion. "Architectural intent"
describes what the design is *trying* to achieve — it is not a statement that the goal has been
achieved or verified. Nothing in this document should be read as, or represented to a user,
investor, or regulator as, legal or Sharia-compliance advice or certification.

## 1. How to use this checklist

Each item lists: the question requiring qualified review, why it matters specifically for PAY2PAY
(grounded in the master spec), what the current design's *architectural intent* is (not a
compliance claim), and status. All items are currently **Not yet reviewed** — no qualified counsel
or scholarly review has occurred as part of producing this documentation set.

## 2. U.S. fintech legal-review items

| # | Item | Why it matters here | Architectural intent (not a legal conclusion) | Status |
|---|---|---|---|---|
| L1 | **Money-transmission analysis** | The platform moves repayment funds between two private parties at scale; most U.S. states regulate money transmission | Route funds processor-side via a payment-facilitator/connected-account model so PAY2PAY never intentionally holds customer funds (§7, FR-ROUTE-001) | Not yet reviewed |
| L2 | **Payment-processor agent structure** | Whether PAY2PAY functions as the processor's registered agent/sub-merchant affects money-transmission exposure directly | Assumes a Stripe Connect-style platform/connected-account relationship; no specific processor agreement exists | Not yet reviewed |
| L3 | **ACH authorization (NACHA rules)** | Every recurring debit requires a valid, revocable authorization | Mandate captured and stored at authorization time, borrower can independently revoke (FR-AGR-008, `docs/PAYMENT_ARCHITECTURE.md` §1) | Not yet reviewed |
| L4 | **Electronic signatures (ESIGN/UETA)** | Agreements must be "legally binding" per §27 | Full consent/identity/hash capture, tamper-evident versioning, downloadable PDF (FR-SIG-001–003) | Not yet reviewed |
| L5 | **Consumer-credit implications (TILA/Reg Z and state equivalents)** | Installment repayment plans can resemble consumer credit even without interest | No interest/finance charges by design (§2); mandatory first payment and fixed schedule differ from open-end credit, but classification is a legal question, not a design choice | Not yet reviewed |
| L6 | **Merchant installment arrangements** | B2C/C2B agreements function like point-of-sale installment plans | Original-invoice-component-only pricing (no time-based charges, §4); still requires review against state retail-installment-sales-act-style statutes | Not yet reviewed |
| L7 | **Debt-collection law (FDCPA and state mini-FDCPA statutes)** | The platform explicitly excludes professional debt collectors (§1) but still facilitates collections-adjacent activity (failed-payment follow-up, hardship, disputes) | Designed to be a neutral scribe/facilitator between original parties, not a third-party collector (§3); this positioning itself needs confirmation | Not yet reviewed |
| L8 | **State licensing (money transmitter, debt-settlement/adjuster, lending)** | Requirements vary by state; a 50-state survey is typically required before national launch | Country/state fields exist in the data model for future jurisdiction-aware logic; no state-specific licensing logic is implemented | Not yet reviewed |
| L9 | **Privacy law (state privacy acts, GLBA if applicable)** | The platform handles financial and identity data at scale | Least-privilege access, encryption, tenant isolation (NFR-PRIV-001–003); GLBA applicability depends on final entity/processor structure | Not yet reviewed |
| L10 | **Data retention** | §28 mandates a specific 7-year baseline | Retention/legal-hold fields modeled at the schema level (`docs/DATA_MODEL.md` §8); whether 7 years satisfies every applicable record-retention statute is a legal question | Not yet reviewed |
| L11 | **Credit reporting (FCRA)** | Not activated in MVP, but the data model reserves fields for later opt-in reporting (§25) | No reporting occurs pre-launch; architecture is forward-compatible only | Not yet reviewed (deferred — lower urgency pre-MVP) |
| L12 | **Fee disclosures** | §2 requires transparent, capped, non-time-based fees | Fee terms captured explicitly in agreement content and shown on the mandatory final review screen (FR-AGR-002, NFR-ACC-005) | Not yet reviewed |
| L13 | **Card surcharging rules** | Card-network and state rules restrict how card-processing costs can be passed to the cardholder | Fee-allocation engine assigns incremental card cost to the borrower on method-switch, but the *mechanism* of disclosure/labeling for surcharge-rule compliance is not yet designed | Not yet reviewed |
| L14 | **Unfair or deceptive acts/practices (UDAP/UDAAP)** | Applies broadly to consumer-facing fintech | No dark patterns, explicit consent, accidental-action prevention (NFR-ACC-004) are UX-level mitigations, not a compliance determination | Not yet reviewed |
| L15 | **Tax reporting (1099-K/1099-MISC etc.)** | Payment volume through the platform may trigger information-reporting obligations for recipients | Not yet designed into the architecture; flagged as a gap for a future deliverable once processor/entity structure is settled | Not yet reviewed — **also an architecture gap, see new open decision** |
| L16 | **OFAC and sanctions screening** | Standard requirement for any U.S. payments-adjacent platform | Expected to be handled by the payment processor/KYC-KYB provider's built-in screening; PAY2PAY does not independently screen | Not yet reviewed |
| L17 | **KYC and business verification (KYB) standards** | §17 requires tiered verification but names no specific regulatory standard to meet | Verification Service wraps a to-be-selected provider (open decision #16); specific CIP/CDD program requirements not yet mapped | Not yet reviewed |

## 3. Sharia-review items

The spec (§2) requires marketing the platform as "ethical, interest-free" while explicitly
prohibiting any claim of formal Sharia compliance until reviewed and approved by qualified
Islamic-finance scholars or a Sharia supervisory body. **No such review has occurred.** The
following are the specific structural elements that would need scholarly review before any
Sharia-related claim could be made:

| # | Item | Why it matters | Status |
|---|---|---|---|
| S1 | **"Ethical, interest-free" marketing language itself** | Risk that this phrasing functions as an implied Sharia-compliance claim even without saying the word "Sharia" (open decision #1) | Not yet reviewed |
| S2 | **Processing/agreement fee structure** | Must be assessed for whether any fee could be characterized as disguised interest (riba) despite being framed as a processing cost (§2) | Not yet reviewed |
| S3 | **Settlement and forgiveness mechanics** | Islamic debt principles have specific views on debt forgiveness and settlement; the platform's settlement structure (§12) has not been reviewed against them | Not yet reviewed |
| S4 | **Hardship/grace-period treatment** | §9 prohibits interest/growth from hardship, which is directionally consistent with Islamic debt-relief principles, but has not been scholar-reviewed | Not yet reviewed |
| S5 | **Witness provisions** | §16's witness feature is directionally consistent with Islamic contract-witnessing principles, but the specific implementation (up to two witnesses, limited access) has not been reviewed for adequacy under any specific school of thought | Not yet reviewed |
| S6 | **Risk-bearing structure (gharar considerations)** | Who bears risk on a failed/returned payment (§7, `docs/PAYMENT_ARCHITECTURE.md`) may be relevant to gharar (excessive uncertainty) analysis | Not yet reviewed |
| S7 | **Governance: which scholar(s) or supervisory body will conduct the review, and under which school of thought / standard-setting body (e.g., AAOIFI)** | Not yet determined — this is a prerequisite decision before any of S1–S6 can proceed | Not yet reviewed — **product/business decision needed first** |

---

**Coverage note:** This checklist implements Section 36, Deliverable 11, including its explicit
instruction to identify items requiring qualified Sharia review separately from the general legal
checklist. One new gap was surfaced (L15, tax information-reporting is not yet represented in the
architecture at all) — logged in `docs/OPEN_DECISIONS.md`. All other items restate risks already
identified in `docs/deliverables/01-executive-summary.md` and `docs/RISK_REGISTER.md` with the
specific legal/scholarly question made explicit rather than left implicit.
