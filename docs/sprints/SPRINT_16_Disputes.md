SPRINT 16 OBJECTIVE:
Implement two distinct dispute systems.

A. AGREEMENT DISPUTE
Examples:
- debt does not exist
- incorrect amount
- evidence challenged
- administration challenged

B. PAYMENT DISPUTE
Examples:
- unauthorized ACH
- unauthorized debit card
- processor dispute

Do not conflate them.

Agreement dispute:
- explanation
- category
- evidence
- response
- status
- audit trail

Scheduled payments continue unless authorization is revoked, both parties agree
to pause, or processor/admin restriction applies.

Payment dispute:
- preserve mandate
- preserve signatures
- preserve identity verification reference
- preserve IP/device/timestamp
- processor handles payment dispute outcome

The platform must not adjudicate legal liability.

Support evidence-package export.

Tests:
- agreement dispute
- payment dispute
- permissions
- evidence
- reversal impact
- balance update

Stop.