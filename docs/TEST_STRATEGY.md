# Deliverable 13: Test Strategy

Source: `docs/PAY2PAY_MASTER_SPEC.md`, Section 36 Deliverable 13, naming 14 required test
categories. Each is mapped to the specific requirements/architecture it verifies. No test code or
test infrastructure is created here — this is the strategy those tests will implement against.

## 1. Unit tests

**Target:** Pure business logic in isolation — fee-allocation calculation, installment/rounding
math (FR-FPAY-002), state-machine transition validity (accept/reject at the function level for all
12 machines in `docs/STATE_MACHINES.md` and `docs/PAYMENT_STATE_MACHINE.md`), ledger posting
generation (`docs/PAYMENT_ARCHITECTURE.md` §14).
**Key invariant to assert everywhere:** money math never uses floating point (FR-MONEY-001) — unit
tests should include a static/lint-level check, not just behavioral tests.

## 2. Integration tests

**Target:** Service-to-service and service-to-database interactions — e.g., Agreement Service
writing through Audit Service (not around it, NFR-AUDIT-002), Verification Service gating
Agreement Service's signature step, Staff & Permissions Service enforcing caps before Requests
Service allows an action through.

## 3. End-to-end tests

**Target:** The 19 user journeys in `docs/deliverables/03-user-journeys.md`, run against a full
(sandboxed) stack — draft-to-signature, first payment, failed payment + retry, hardship,
settlement, dispute, CSV import, staff approval, account restriction, appeal, each exactly as
narrated in that deliverable.

## 4. Payment webhook tests

**Target:** The signature-verify → dedupe → dispatch → state-machine-apply pipeline
(`docs/ARCHITECTURE.md` §5): valid signed events apply correctly; invalid-signature events are
rejected before touching any state; events implying an invalid transition for the record's current
state are routed to manual review, not silently applied (`docs/PAYMENT_ARCHITECTURE.md` §12);
redelivered (duplicate) events are safe no-ops.

## 5. Idempotency tests

**Target:** FR-MONEY-002 (outbound) and FR-MONEY-003 (inbound) directly. Concrete cases: submitting
the same payment-initiation request twice with the same idempotency key produces exactly one
charge; replaying the same webhook event ID twice produces exactly one state transition; concurrent
requests racing to create the same automatic-retry attempt result in exactly one row (ties to
Security Model SEC threat "Duplicate withdrawals," `docs/SECURITY_MODEL.md` §6).

## 6. Authorization tests

**Target:** The Deliverable 2 permissions matrix, enforced — every FR-* action gated by a specific
role, tested both as "allowed for the intended role" and "denied for every other role," including
witness-boundary tests (a witness can never reach a sensitive-document endpoint, FR-EVID-005) and
administrator-boundary tests (an administrator action can never alter a signed agreement,
FR-ADMIN-002).

## 7. Row-level isolation tests

**Target:** NFR-PRIV-002 and `docs/DATA_MODEL.md` §11's tenant isolation model — a user with both a
personal and business profile cannot cross-read the other's data; an unrelated business's staff
member cannot read a different business's agreements even with a guessed/enumerated ID; RLS policy
is tested as one layer, with a second, independent application-layer authorization test suite per
NFR-SEC-001 (ties to Security Model SEC-05, `docs/SECURITY_MODEL.md` §11).

## 8. Agreement immutability tests

**Target:** FR-AGR-006 directly — attempt to `UPDATE` a `agreement_version` row where `signed_at IS
NOT NULL` and confirm it is rejected at the database layer, not merely blocked in application code;
confirm every amendment produces a **new** version row rather than mutating the version it amends;
confirm an administrator account cannot bypass this (ties to FR-ADMIN-002).

## 9. Signature tests

**Target:** FR-SIG-001–003 — every required field (consent, identity attribution, IP, device,
timestamp, timezone, auth method, document hash, witness attestations) is actually captured and
persisted on signing; the generated PDF matches the signed terms exactly; tampering with a stored
signed document (in a test harness) is detectable via the stored hash; an agreement cannot reach
`Signed` status with only one party's signature captured (FR-AGR-005).

## 10. Accessibility tests

**Target:** NFR-ACC-001–005 — automated WCAG 2.2 AA scanning on every core flow, manual
keyboard-only and screen-reader walkthroughs specifically of the signing and bank-account-change
flows (the two flows the spec singles out for accidental-action prevention, NFR-ACC-004), and a
rendering test confirming the mandatory final review screen (NFR-ACC-005) always shows every
required field before the signature control is enabled.

## 11. Security tests

**Target:** Every entry in `docs/SECURITY_MODEL.md`'s summary table (§17) gets at least one test
scenario: forged-signature attempt via a tampered request, webhook-spoofing attempt with an invalid
signature, invitation-link reuse-after-acceptance attempt, cross-tenant enumeration attempt,
payout-redirection attempt without MFA, document upload with an EICAR-style test malware payload.
Security testing is scheduled **before** any stage in `docs/ROADMAP.md` that moves real money
(Stage 4 Closed beta onward).

## 12. Fraud scenarios

**Target:** Each pattern named in FR-FRAUD-002 gets a synthetic test case: duplicate identity
signup, shared bank account across two unrelated test users, rapid agreement creation from one
device, a self-payment attempt, a circular-payment pattern across three test agreements — confirming
the pattern is flagged (not necessarily blocked outright, per FR-FRAUD-004's "no automatic agreement
erasure" rule) and routed to the correct response tier (FR-FRAUD-003).
**Explicit non-goal:** these tests validate *detection*, not prevention of collusion between
consenting real parties — per `docs/SECURITY_MODEL.md` §14, that residual risk is accepted, not
testable-to-zero.

## 13. Disaster recovery tests

**Target:** NFR-DR-001–002 — a scheduled restore drill that provisions a working environment from
the most recent backup and validates data integrity (including that `audit_event` hash-chaining is
intact post-restore); this test category is currently unable to assert a specific time bound since
no RTO/RPO is defined (open decision #14) — the test validates *that restore works*, not yet
*within what time*, until that target is set.

## 14. Load tests

**Target:** NFR-SCALE-001–003 — horizontal scaling of the interactive request layer under
increasing concurrent sessions; webhook-ingestion burst handling without interactive-path
degradation; a large CSV import running concurrently with normal traffic without user-visible
slowdown. As with disaster recovery, these tests currently validate *relative* behavior (scaling
works, isolation holds) rather than *absolute* numeric targets, since no concrete scale figures
exist yet (open decisions #11, #13).

---

## Coverage vs. currently-undefined numeric targets

Three categories above (Accessibility timing aside) cannot yet be run to a **pass/fail numeric
threshold** because the master spec itself does not specify one:

| Category | Missing numeric input | Open decision |
|---|---|---|
| Load tests | Expected concurrent users / agreements-per-month | #11, #13 |
| Disaster recovery tests | RTO / RPO | #14 |
| (Availability, tested indirectly via load/DR) | Uptime SLA | #12 |

These tests can and should still be **built** now (structurally ready, asserting relative/qualitative
success), with numeric pass/fail gates added once the corresponding open decisions are resolved —
this is called out explicitly in `docs/IMPLEMENTATION_PLAN.md`'s testing gates rather than silently
assumed.

**Coverage note:** All 14 test categories named in Section 36, Deliverable 13, are addressed above.
No new open decisions are introduced; this deliverable surfaces where three *existing* open
decisions (#11, #13, #14) concretely block setting numeric test thresholds, which is a more precise
restatement of their impact than previously captured.

*Companion: `docs/IMPLEMENTATION_PLAN.md`, whose per-phase "Testing gate" column references these
categories directly.*
