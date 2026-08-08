SPRINT 13 OBJECTIVE:
Implement the agreed failed-payment workflow.

When payment fails:

1. Mark failure.
2. Notify both parties.
3. Display non-sensitive failure category.
4. Permit borrower manual payment.
5. Schedule one retry after configurable delay.
6. Default configuration: approximately 3 business days.
7. Cancel retry if manual payment succeeds.
8. If retry fails, stop automatic retries.
9. Borrower may request new payment date.
10. Creditor approval required to formally reschedule.

Never implement uncontrolled retries.

No automatic late fees.

Preserve original installment record.

Build background job/scheduler abstraction compatible with Vercel architecture.

Tests:
- initial failure
- retry
- manual success cancels retry
- retry failure
- no third automatic retry
- reschedule request

Stop.