SPRINT 11 OBJECTIVE:
Implement ACH payment behavior in sandbox/test mode.

Required lifecycle:

SCHEDULED
SUBMITTED
PROCESSING
CLEARED
PAYOUT_PENDING
PAID_OUT

Failure:
FAILED
RETURNED
REVERSED
DISPUTED

Implement:

- borrower mandate/authorization record
- first payment
- recurring schedule
- manual payment
- processor event handling
- ledger postings
- recipient payout representation
- authorization revocation
- bank-change hooks

Signed agreement remains valid after failed payment.

Revoking authorization stops future automatic debits but does not erase debt.

No unsettled ACH funds may be treated as received by creditor.

Tests:
- pending
- success
- NSF
- returned
- revoked mandate
- duplicate debit prevention
- first payment failure
- payout only after cleared state

Stop.