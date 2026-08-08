SPRINT 10 OBJECTIVE:
Implement the internal double-entry-style ledger and reconciliation foundation.

This ledger records financial events.
It does not imply PAY2PAY holds funds.

Create accounts and journal-entry architecture sufficient to record:

- installment obligation
- payer debit
- processor fee
- platform fee
- recipient proceeds
- refunds
- reversals
- returns
- payout
- dispute adjustments

Ledger rules:

- balanced entries
- immutable posted entries
- corrections via compensating entries
- no destructive edits
- integer minor units
- currency required
- processor reference required where relevant
- agreement/installment/payment linkage

Create reconciliation process comparing internal records with processor events.

Tests:
- balance invariant
- duplicate event
- reversal
- refund
- processor fee
- payout
- reconciliation mismatch

Do not enable production transactions.

Stop.