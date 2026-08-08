SPRINT 8 OBJECTIVE:
Complete business-to-business workflows and business bulk draft creation.

B2B:

Both parties must use verified business profiles.

Record:
- legal entities
- authorized signers
- titles
- signing authority
- invoice/PO/contract references

Business dashboards must expose:

Accounts Receivable
Accounts Payable
Active Agreements
Upcoming Payments
Past Due
Settlements
Disputes

CSV import:

Support drafts for:
- customers
- invoices
- balances
- proposed plans

CSV flow:

UPLOAD
VALIDATE
PREVIEW
DUPLICATE CHECK
ERROR REPORT
CREATE DRAFTS

Never bulk activate.

Every debtor must individually authenticate, acknowledge, and sign.

Implement robust validation and error reporting.

Do not build QuickBooks/Xero integrations yet.

Create integration interfaces/placeholders only if already specified.

Tests:
- B2B authorization
- signer authority
- import validation
- duplicate handling
- invalid row
- no bulk activation
- tenant isolation

Stop.