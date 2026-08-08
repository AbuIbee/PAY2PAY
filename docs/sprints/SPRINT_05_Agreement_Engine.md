SPRINT 5 OBJECTIVE:
Build the canonical repayment-agreement engine.

This sprint implements agreements only.
Do not integrate live payments.

Supported relationship types:

- P2P
- B2C
- C2B where applicable
- B2B

Either party may initiate a draft.

The debtor must formally acknowledge the obligation.

Required agreement fields:

- category
- description
- original amount
- previous payments
- current principal
- currency
- creditor
- debtor
- first payment
- installment amount
- frequency
- schedule
- final payment
- proposed fee allocation
- early payoff terms
- hardship rules
- partial payment rules
- settlement rules
- dispute procedure
- supporting evidence references

Use integer minor units for all money.

Implement schedule calculation.

Handle rounding deterministically.

Agreement lifecycle:

DRAFT
AWAITING_DEBTOR_ACKNOWLEDGMENT
AWAITING_CREDITOR_ACCEPTANCE
AWAITING_SIGNATURES
SIGNED
FIRST_PAYMENT_PENDING
ACTIVE
PAST_DUE
DISPUTED
PAUSED_BY_AMENDMENT
PAID_IN_FULL
SETTLED_IN_FULL
MUTUALLY_CANCELED
CLOSED

Do not allow invalid transitions.

AGREEMENT VERSIONING

Signed versions are immutable.

Changes must create amendments/new versions.

Never UPDATE signed terms in place.

Implement audit events.

Implement debtor acknowledgment language.

Implement creditor approval/rejection/counterproposal.

Build backend/API/server actions plus functional UI.

Cursor may refine visual workflow later.

Required tests:

- P2P
- B2C
- B2B
- debtor acknowledgment
- creditor acceptance
- counter
- rejection
- unauthorized access
- schedule arithmetic
- rounding
- immutable signed record
- invalid state transitions

Update documentation.

Stop after Sprint 5.