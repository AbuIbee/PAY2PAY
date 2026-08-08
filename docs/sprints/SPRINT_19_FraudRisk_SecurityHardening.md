SPRINT 19 OBJECTIVE:
Implement internal fraud/risk controls and perform application security hardening.

Risk indicators include:

- duplicate identity
- same bank across suspicious accounts
- suspicious device reuse
- agreement velocity
- high-value velocity
- repeated payment failure
- returns/chargebacks
- frequent bank changes
- extreme settlement discounts
- payout redirection
- business activity through personal profile
- unverifiable invitees
- account rings
- circular payments
- self-payments
- collusion
- account takeover

Responses:

- flag
- additional verification
- manual review
- agreement restriction
- payment restriction
- payout hold
- temporary suspension

Do not permanently ban solely from one automated score without approved review policy.

Security verification:

- IDOR
- RLS bypass
- privilege escalation
- session theft
- CSRF
- XSS
- SQL injection
- webhook spoofing
- replay
- rate-limit bypass
- document attack
- secrets exposure
- tenant isolation
- payout modification

Produce:
docs/SECURITY_AUDIT_REPORT.md

Do not claim independent penetration-testing certification.

Stop.