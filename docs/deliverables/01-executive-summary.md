# Deliverable 1: Executive Product Summary

Source: `docs/PAY2PAY_MASTER_SPEC.md`. This deliverable does not introduce business rules beyond
that spec; where a point is genuinely undecided, it is flagged as an open decision rather than resolved here.

## The Product

PAY2PAY is a U.S.-only, mobile-responsive web application (Progressive Web App) that lets two
parties — a person or business who is owed money ("creditor") and a person or business who owes
it ("borrower") — turn an existing, already-incurred debt or invoice into a formal, mutually
signed repayment agreement, and then execute that repayment through ACH or debit-card payments.

It is explicitly **not** a lender and **not** a payment custodian. PAY2PAY is the neutral digital
scribe and process layer around a payment processor: it helps two parties document what is owed,
get both signatures, run a mandatory first payment, schedule and track the remaining installments,
and handle the operational lifecycle around that agreement (amendments, hardship, partial
payments, settlements, disputes, evidence, witnesses). Money itself moves from payer to verified
recipient through a qualified payment processor (e.g., a Stripe Connect–style model); PAY2PAY does
not advance funds, does not guarantee repayment, and does not intentionally hold customer money in
its own operating account.

The product is positioned as an **ethical, interest-free repayment platform**, influenced by
Islamic debt principles (no interest/riba, no percentage-based or compounding late fees, no
charges for the mere passage of time, no prepayment penalties), but it must not claim formal
Sharia compliance until that claim is reviewed and approved by qualified Islamic-finance scholars
or a Sharia supervisory body. See open decision #1.

The platform supports four repayment relationship shapes: personal-to-personal,
business-to-consumer, consumer-to-business, and business-to-business — with B2B agreements
requiring both sides to act through separately identified business profiles, each with an
authorized representative. Business identity verification is required before a business can
receive funds or activate payment capability, not before it can act or sign.

## Target Users

- **Individuals and friends/family** formalizing an informal debt (e.g., a personal loan between
  friends) into a documented, trackable repayment plan.
- **Sole proprietors, small businesses, contractors, freelancers, and repair/service businesses**
  (e.g., mechanics) offering installment repayment for goods already delivered or services already
  completed.
- **Merchants** offering installment repayment on completed transactions.
- **Verified businesses transacting with other verified businesses** (B2B): vendors, subcontractors,
  wholesalers, equipment sellers, and other commercial creditors collecting past-due or scheduled
  invoices from another business.
- **Business staff** (owners, managers, receivables staff, accountant/viewer roles) operating the
  platform on behalf of a business profile under role-based permissions.
- Supporting roles: **optional witnesses** to an agreement, and **platform administrators / compliance
  reviewers / support agents** operating the internal side of the system.

Users must be 18 or older; underage users are blocked. All launch users, currency, and payment rails
are U.S.-only, though the data model reserves country/currency/timezone/locale fields for future
international expansion (not activated in the MVP).

## Core Value Proposition

- **Turns an informal or invoiced debt into a real, enforceable, electronically signed agreement**
  in minutes, with both parties acknowledging the same facts (amount, reason, prior payments,
  remaining balance, schedule) before anything is legally binding.
- **No interest, no compounding, no percentage-based late fees, no charges for taking longer to
  pay** — repayment terms cannot silently grow the debt. Any legitimate fee (processing,
  agreement, access) must be transparent, disclosed, non-time-based, and capped.
- **Money only moves when it clears** — recipients are paid via a qualified payment processor as
  each installment successfully settles; the platform is structurally not in the business of
  advancing, guaranteeing, or holding customer funds.
- **Full lifecycle support**, not just a one-time signature: failed-payment retries, hardship
  requests, partial payments, early payoff, settlements, and disputes are all first-class,
  auditable workflows rather than manual side conversations.
- **Built-in evidence and audit trail**: supporting documents, tamper-evident signed PDFs, witness
  attestations, and an append-only audit log make the agreement defensible if a disagreement or
  payment dispute later arises.
- **Works for both informal (personal) and formal (business, B2B) relationships** under one
  platform, with strict separation between personal and business profiles, activity, and records.

## What the Platform Is Not

- Not a lender, and not in the business of advancing loan proceeds.
- Not a guarantor of repayment.
- Not an intentional custodian of customer funds (money is expected to route through the payment
  processor directly to the verified recipient, not sit in PAY2PAY's operating account).
- Not a debt collector, debt buyer, payday lender, interest-bearing lender, medical-debt or
  child-support collector, or court-judgment enforcement service — those categories are explicitly
  excluded from the platform at launch.
- Not a Sharia-certified financial product — it is "influenced by" Islamic debt principles but
  cannot claim formal Sharia compliance absent qualified scholarly/supervisory approval.
- Not a chat platform — no unrestricted internal messaging in the MVP; structured,
  agreement-specific communication (hardship, amendments, disputes, settlement requests) is a
  later-phase feature, and users remain free to communicate outside the app for anything informal.
- Not a credit bureau data furnisher at launch — no credit reporting is activated in the MVP,
  though the data model is meant to support adding optional, opt-in, positive-only reporting later.
- Not an automatic legal arbiter — the platform documents and routes disputes (both debt disputes
  and unauthorized-payment disputes) but does not itself decide who is legally correct.
- Not a same-day/instant-funds product in the MVP — no platform-funded advances, no guaranteed
  payouts, no instant access to unsettled ACH funds.

## MVP Boundaries

**In scope for MVP** (per spec Section 35): responsive PWA; personal and business profiles; tiered
identity verification; ACH and debit-card payments; payment agreements with mandatory first
payment; electronic signatures and PDF generation; amendments; hardship requests; partial-payment
requests; settlements; disputes; supporting evidence; optional witnesses; email/SMS/in-app
notifications; business staff roles with configurable permissions; CSV draft imports (draft-only,
no bulk activation); an internal administrative dashboard; fraud flags; email-only customer
support; an appeals process; a full audit trail; and a seven-year retention model.

**Out of scope for MVP**: international payments and multi-currency support; credit-bureau
reporting; unrestricted internal chat; native iOS/Android apps; instant access to unsettled funds;
platform-funded lending; debt purchasing; professional collections activity; interest or
profit-generating late fees; accounting-system integrations beyond an abstraction placeholder; and
any AI-based decision-making that approves, rejects, or legally adjudicates users.

## Primary Legal and Operational Risks

- **Money-transmission / licensing exposure.** The intended architecture (processor routes funds
  directly to the verified recipient; platform does not intentionally hold funds) points toward a
  payment-facilitator or agent-of-payee model rather than a money-transmitter model, but this is an
  architectural intent, not a legal conclusion — it requires review by qualified U.S. fintech
  counsel before launch. See open decision #2.
- **Payment-processor underwriting risk.** Debt-repayment/installment-collection use cases can draw
  extra scrutiny from payment processors. No provider has confirmed approval of this business
  model, and no contingency processor has been selected. See open decision #3.
- **"Ethical, interest-free" marketing vs. no-Sharia-compliance-claim requirement.** These two
  spec requirements sit close enough together that marketing/UI copy must be deliberately worded to
  avoid implying a certification that hasn't been obtained. See open decision #1.
- **Consumer-credit / debt-collection law adjacency.** Even though PAY2PAY is not a lender or
  collector, formalizing repayment plans for consumer debts touches areas (installment disclosures,
  fee caps, unfair-or-deceptive-practices exposure, state-by-state licensing variation) that need
  legal sign-off; the spec explicitly defers these to Deliverable 11 rather than resolving them here.
- **Fraud and misuse surface.** The relationship model (any two parties can create a debt
  acknowledgment) creates room for collusive or fabricated agreements, self-payments, and
  business-activity-disguised-as-personal-activity; this drives real requirements for tiered
  verification, fraud rules, and business/personal activity separation (detailed in later
  deliverables).
- **Operational risk of signed-agreement immutability.** Because signed agreements must never be
  overwritten and administrators must never be able to alter a signed record, every correction path
  (amendments, settlements, disputes) must be modeled as an additive, versioned, approved change —
  a nontrivial data-model and workflow constraint carried into Deliverables 7 and 8.

---
*Next phase: Deliverable 2 — User roles and permissions matrix.*
