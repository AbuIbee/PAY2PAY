SPRINT 15 OBJECTIVE:
Implement partial payment and settlement workflows.

PARTIAL PAYMENT

Borrower proposes:
- amount
- date
- treatment of remainder

Creditor:
- accept
- reject
- counter

Acceptance does not forgive remainder automatically.

SETTLEMENT

Record:
- pre-settlement balance
- settlement amount
- forgiven amount
- deadline
- one-time vs schedule
- failed-settlement consequence

Explicit failed-settlement options:

- restore original unpaid balance
- restore specified balance
- retain specified forgiveness
- prior agreement remains controlling pending negotiation

Successful settlement:
SETTLED_IN_FULL

Never mark as PAID_IN_FULL.

Approving a settlement is a master-spec-listed MFA-gated action. Call Sprint 2's
`requireStepUp(user, "approve_settlement")` before finalizing creditor acceptance of a settlement.
Do not implement a second, competing authentication mechanism.

Tests cover all consequences.

Stop.