SPRINT 12 OBJECTIVE:
Implement debit-card payments in sandbox/test mode.

Support:

- tokenized card
- initial payment
- recurring payment where processor permits
- decline
- expired card
- replaced card
- dispute
- refund

Fee rule:

If borrower switches from ACH to a more expensive debit-card method,
the borrower pays the incremental processor cost unless the signed agreement or
mutual amendment states otherwise.

Do not silently reduce creditor net proceeds.

Never store full card numbers or CVV.

Ledger and webhook behavior must match the payment abstraction.

Tests:
- approved
- decline
- expired
- dispute
- refund
- card replacement
- fee allocation
- duplicate request

Stop.