SPRINT 9 OBJECTIVE:
Build the provider-independent payments abstraction and sandbox architecture.

NO PRODUCTION MONEY.

Evaluate the existing architecture against:

- Stripe Connect
- ACH Direct Debit
- Financial Connections
- debit cards
- Plaid alternatives

Do not assume provider approval.

Document recommended processor and contingency.

Create payment provider interfaces for:

- create recipient/connected account
- bank linking
- payment method token
- create payment
- retrieve payment
- cancel when permitted
- refund
- dispute event
- payout event
- webhook verification

Application business logic must depend on the abstraction, not Stripe-specific code.

The abstraction's "create payment" entry point must call Sprint 3's `isFullyVerified(profile)` for
both payer and recipient profiles before creating any payment, and reject with a clear error if
either is not `FULL_VERIFIED`. Enforce this once, here, in the shared abstraction — individual
provider adapters (Sprint 11 ACH, Sprint 12 debit card) and the ledger (Sprint 10) must not be able
to bypass it by calling a provider directly.

Implement sandbox/test provider integration only after verifying configuration.

Never store:
- full card number
- bank login credentials
- raw routing/account numbers unless specifically permitted and necessary;
prefer tokens/provider IDs.

Implement webhook:
- signature verification
- replay protection
- idempotency
- event persistence
- asynchronous processing

No UI should claim that sandbox transactions are real.

Tests:
- provider adapter
- webhook spoof
- replay
- idempotency
- duplicate event
- processor failure
- payment creation blocked when payer not FULL_VERIFIED
- payment creation blocked when recipient not FULL_VERIFIED

Update PAYMENT_ARCHITECTURE.md.

KYC/KYB PROVIDER INTEGRATION (additive — payment-provider abstraction scope above stays intact
and unchanged)

Sprint 9 also owns the actual KYC/KYB provider integration that fills in the verification
architecture Sprint 3 already built. This is a separate abstraction from the payment-provider
abstraction above; do not merge the two interfaces.

- Evaluate candidate KYC/KYB providers; document recommended provider and contingency, same
  discipline as the payment-provider evaluation above. Do not assume provider approval.
- Create a KYC/KYB provider interface: submit verification (individual and business), retrieve
  verification result/status, government-ID check, selfie/liveness check, bank-account-ownership
  check, webhook/callback for asynchronous verification outcomes.
- Wire this interface to Sprint 3's per-profile verification-status state machine: a provider
  callback transitions a profile from `FULL_PENDING` to `FULL_VERIFIED` or `FULL_REJECTED`. Sprint
  3's `isFullyVerified` interface and its callers (Sprint 6 signing gate, Sprints 9–12 payment
  gates) require no changes — only the mechanism producing the status changes.
- Sandbox/test mode only, consistent with "NO PRODUCTION MONEY" above. No UI may claim that
  sandbox verification is a real identity check.
- Webhook signature verification, replay protection, and idempotency requirements above apply
  equally to the KYC/KYB provider's webhooks.
- Never store the raw government-ID image or selfie beyond what the provider integration requires
  in transit; prefer provider-side storage and a reference/token, consistent with the "never store
  full card number, bank login credentials, raw routing/account numbers" discipline above.

Tests:
- provider adapter (KYC/KYB)
- webhook spoof (KYC/KYB)
- FULL_PENDING to FULL_VERIFIED transition
- FULL_PENDING to FULL_REJECTED transition
- profile remains gated (isFullyVerified false) while PENDING or REJECTED
- duplicate verification submission

Stop.