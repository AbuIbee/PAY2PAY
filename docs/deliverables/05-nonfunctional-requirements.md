# Deliverable 5: Nonfunctional Requirements

Source: `docs/PAY2PAY_MASTER_SPEC.md`, primarily Section 33 (technical expectations), Section 34
(accessibility/UX), Section 28 (retention), Section 32 (audit integrity), Section 26 (MFA), and
Section 37 (critical working rules). Covers the eleven categories named in Section 36, Deliverable 5.
Each requirement is uniquely numbered `NFR-<CAT>-<NNN>` and includes a verification approach, since
these ultimately need to be testable (Deliverable 13). Where the spec does not state a concrete
number (an SLA, a latency budget, a scale target), the requirement states the qualitative
obligation and the missing number is logged in `docs/OPEN_DECISIONS.md` rather than invented here.

## Security

**NFR-SEC-001 — Defense in depth; no single control as the whole strategy.** Authorization is
enforced through row-level authorization, role-based access control, and attribute-based
restrictions where needed, layered together. Database-level row-level security (e.g., Postgres
RLS/Supabase RLS) is one layer, never treated as the entire security strategy (explicit spec
instruction, §33).
- Verification: security review confirms authorization is also enforced at the application/service
  layer independent of any single database-level policy.

**NFR-SEC-002 — Encryption in transit and at rest.** All data in transit uses TLS; all data at rest
(database, object storage, backups) is encrypted.
- Verification: infrastructure configuration audit; no plaintext-at-rest storage for the datastore
  or backup targets.

**NFR-SEC-003 — Secrets management.** Credentials, API keys, and signing secrets are stored in a
dedicated secrets manager, never in source control or plaintext configuration.
- Verification: repository secret-scanning; secrets sourced only from the secrets-management layer
  at runtime.

**NFR-SEC-004 — Rate limiting.** Authentication, signing, payment-initiation, and invitation-
acceptance endpoints are rate-limited per account/IP/device to reduce credential-stuffing, signing-
abuse, and invitation-guessing risk.
- Verification: load/abuse testing confirms limits trigger before resource exhaustion or brute-force
  success.

**NFR-SEC-005 — Webhook signature verification.** Every inbound payment-provider webhook is
signature-verified before its payload is trusted or acted on (ties to FR-MONEY-003).
- Verification: webhook handler unit/integration tests reject unsigned or invalid-signature payloads.

**NFR-SEC-006 — Secure session management.** Sessions use secure, rotating tokens with defined
expiry and revocation on logout, password/passkey change, or suspected compromise.
- Verification: session-fixation and token-replay tests; revocation confirmed to invalidate active
  sessions immediately.

**NFR-SEC-007 — Device and login monitoring.** New-device logins and anomalous login patterns are
detected and surfaced to fraud/risk review (ties to FR-FRAUD-002).
- Verification: simulated new-device login generates a detectable signal.

**NFR-SEC-008 — No raw financial credential storage.** Enforced platform-wide, not just at the
payment layer (ties to FR-PAYMETHOD-002); applies equally to logs, error reports, and support
tooling — sensitive payment data must never appear unmasked outside the payments provider.
- Verification: log/error-report audit for PAN, CVV, or raw account/routing numbers.

## Performance

**NFR-PERF-001 — Interactive flows respond promptly across all target devices.** Core flows
(agreement creation, review, signing, payment initiation) remain usable and responsive on the
device classes named in the spec: iPhone, Android phones, iPad, Android tablets, Windows laptops,
MacBooks, Chromebooks, and modern desktop/mobile browsers (§1).
- Verification: manual and automated testing across the named device/browser matrix.
- Note: the spec does not state a numeric latency or page-load budget; a concrete target (e.g.,
  p95 API response time, time-to-interactive) is an open decision (see `docs/OPEN_DECISIONS.md`).

**NFR-PERF-002 — Asynchronous handling of heavy or slow operations.** PDF generation, document
hashing/virus scanning, notification dispatch, and webhook-triggered processing run as background
jobs rather than blocking the user-facing request (§33: background jobs, queueing).
- Verification: interactive endpoints for these flows return promptly while the underlying work
  completes asynchronously, confirmed via job-queue instrumentation.

## Reliability

**NFR-REL-001 — Idempotent payment processing.** Every payment-initiating and webhook-consuming
operation is idempotent, so retried requests or redelivered webhook events never duplicate a charge,
payout, or balance update (ties to FR-MONEY-002).
- Verification: repeated submission of the same payment/webhook request produces exactly one
  state-changing effect.

**NFR-REL-002 — Infrastructure-level retry with backoff is distinct from the business-level payment
retry rule.** Transient failures in background jobs, webhook delivery, or notification dispatch may
retry with backoff at the infrastructure layer; this is separate from, and must not be conflated
with, the single business-level automatic payment retry defined in FR-FAIL-003. An infrastructure
retry of a failed *delivery* (e.g., a dropped webhook call) is not a second business-level payment
attempt.
- Verification: test that infrastructure-level redelivery of an already-processed webhook event is
  a no-op (per NFR-REL-001), and does not trigger a second FR-FAIL-003 retry.

**NFR-REL-003 — Dead-letter handling for failed background jobs.** A background job that
permanently fails after its retry budget is moved to a dead-letter queue for manual review, not
silently dropped.
- Verification: forced job failure past retry budget is observable in a dead-letter store.

## Availability

**NFR-AVAIL-001 — High-availability posture appropriate to a time-sensitive financial application.**
Because agreements carry scheduled, date-bound payment obligations, the platform is architected to
avoid single points of failure in the request path and in scheduled-job execution (which drives
first payments, retries, and recurring installments).
- Verification: architecture review confirms no single-instance dependency for scheduling/payment
  execution.
- Note: the spec states no numeric uptime SLA (e.g., 99.9%); a concrete target is an open decision.

## Accessibility

**NFR-ACC-001 — WCAG 2.2 AA target.** The application targets WCAG 2.2 Level AA across its core
user-facing flows.
- Verification: automated accessibility scanning plus manual audit (screen reader, keyboard-only
  navigation) prior to each major release.

**NFR-ACC-002 — Plain-language, mobile-first, high-contrast, large-touch-target design.** UI
follows plain-language copy, mobile-first responsive layout, large touch targets, and high-contrast
support (§34).
- Verification: design-review checklist and accessibility audit.

**NFR-ACC-003 — Keyboard and screen-reader compatibility.** All interactive elements, including the
signing flow, are operable via keyboard alone and correctly announced by screen readers.
- Verification: keyboard-only and screen-reader walkthroughs of the signing and payment flows
  specifically, given their legal/financial weight.

**NFR-ACC-004 — No dark patterns; explicit consent; accidental-action prevention.** The UI avoids
manipulative design patterns, requires explicit consent for signing and financial-detail changes,
and includes friction (e.g., confirmation steps) to prevent accidental signing or accidental
bank-account changes (§34).
- Verification: UX review against a documented dark-pattern checklist; targeted usability testing of
  the signing and bank-account-change flows.

**NFR-ACC-005 — Mandatory final review screen before signing.** The signing flow includes a final
review screen summarizing what is owed, why, first payment, later payments, dates, fees, payment
method, total borrower outflow, net recipient proceeds, cancellation rules, ACH revocation rights,
amendment rules, and dispute process (§34) — this is a UX/accessibility requirement distinct from
the signature-capture mechanics in FR-SIG-001.
- Verification: UI test confirms the review screen renders all listed fields before the signature
  action is enabled.

## Auditability

**NFR-AUDIT-001 — System-wide append-only audit trail.** Every state-changing action in the system
(not just administrative actions) is recorded in the append-only audit architecture defined in
FR-AUDIT-001/002, so the platform as a whole — not just the admin surface — is auditable after the
fact.
- Verification: sampling of agreement lifecycle, payment, staff, and admin actions confirms each
  produces a corresponding audit record with the required fields.

**NFR-AUDIT-002 — Tamper-resistance is a system property, not a feature toggle.** Event hashing,
immutable storage, and restricted write access (FR-AUDIT-003) apply uniformly; there is no
code path that writes an audit-relevant change without also writing its audit record.
- Verification: code review / static analysis confirming state-mutation paths are coupled to audit
  writes; attempted direct mutation of an audit record is rejected at the storage layer.

## Scalability

**NFR-SCALE-001 — Stateless, horizontally scalable request-handling layer.** Application services
handling interactive requests are stateless, allowing horizontal scaling independent of background
job/queue capacity.
- Verification: architecture review; load testing confirms throughput scales with added instances.

**NFR-SCALE-002 — Decoupled, independently scalable async processing.** Webhook ingestion,
notification dispatch, and document processing run on a queue-backed worker pool that can scale
independently of the interactive request path, so a burst of payment webhooks does not degrade
agreement-browsing or signing performance.
- Verification: load test that saturates webhook ingestion and confirms interactive-flow latency is
  unaffected.

**NFR-SCALE-003 — Bulk import does not degrade interactive paths.** A large CSV import (FR-CSV-001)
processes through the same async/queued mechanism as other heavy operations, so a large business
import does not block or slow other users' interactive sessions.
- Verification: load test of a large CSV import running concurrently with normal interactive traffic.
- Note: the spec gives no concrete expected volume (agreements/month, concurrent users, CSV row
  count ceiling); concrete scale targets are an open decision.

## Privacy

**NFR-PRIV-001 — Least-privilege access to sensitive data.** Government ID, bank credentials,
complete account/card numbers, and identity-verification documents are accessible only to the
roles and system components strictly necessary (payment processor, identity-verification provider,
and narrowly authorized compliance/admin review), consistent with the Deliverable 2 permissions
matrix and FR-EVID-004.
- Verification: access-control audit confirms no role outside the defined set can query sensitive
  fields; access by an authorized reviewer is itself audit-logged (ties to NFR-AUDIT-001).

**NFR-PRIV-002 — Business/personal data separation.** Personal-profile and business-profile data
for the same login are stored and access-controlled as logically separate tenants, consistent with
FR-PROF-002.
- Verification: cross-profile query test confirms no unintended data leakage between a user's
  personal and business profiles.

**NFR-PRIV-003 — Data minimization on deletion.** Where legally permitted, unrelated personal data
is minimized or deleted on account-deletion request, without touching records under legal/retention
hold (ties to FR-RET-003).
- Verification: deletion-request test confirms retained-record fields survive while eligible
  unrelated data is removed.

## Retention

**NFR-RET-001 — Seven-year baseline retention enforced at the storage layer.** Completed
agreements, payment records, signatures, evidence, and audit logs are retained for seven years
after agreement closure by policy enforced in the data layer, not only by application-level
convention (ties to FR-RET-001).
- Verification: attempted early deletion of a within-retention record is rejected or requires an
  explicit, audited legal-hold override path.

**NFR-RET-002 — Backups honor the same retention and legal-hold rules as primary storage.** Backup
retention/purge scheduling does not delete backup copies of records still under the seven-year
policy or an active legal hold, and does not retain deleted, non-held personal data indefinitely
past its minimization point either.
- Verification: backup lifecycle policy review; this reconciliation mechanism is not detailed in the
  spec and is logged as an open decision (see `docs/OPEN_DECISIONS.md`).

## Disaster recovery

**NFR-DR-001 — Regular encrypted backups with tested restore.** The system takes regular encrypted
backups of the primary datastore and object storage, with periodically tested restore procedures
(§33: "Backup and disaster recovery").
- Verification: scheduled restore-drill produces a working environment from backup within a defined
  window.
- Note: the spec does not state numeric Recovery Time Objective / Recovery Point Objective targets;
  these are an open decision.

**NFR-DR-002 — Documented disaster recovery plan.** A written DR plan defines failure scenarios,
responsible parties, and recovery steps, kept current as architecture evolves.
- Verification: DR plan exists, is version-controlled, and is exercised at a defined cadence
  (cadence itself is part of the open RTO/RPO decision above).

## Observability

**NFR-OBS-001 — Structured logging across services.** Application, background-job, and webhook-
handling components emit structured (not free-text-only) logs suitable for correlation across a
single request or payment lifecycle.
- Verification: a sample payment's logs can be traced end-to-end (initiation → webhook → state
  change → notification) via a shared correlation identifier.

**NFR-OBS-002 — Monitoring and alerting on payment- and webhook-path health.** Webhook processing
failures, elevated payment-failure rates, and dead-lettered jobs (NFR-REL-003) generate operational
alerts, given the direct financial and time-sensitive impact of failures in this path.
- Verification: forced webhook-processing failure triggers an alert within a defined window.

**NFR-OBS-003 — Fraud/risk signal visibility.** Elevated volume of any flagged pattern from
FR-FRAUD-002 (e.g., a spike in shared-device signups, rapid agreement creation) is visible on an
operational dashboard, supporting the manual-review responses required by FR-FRAUD-003.
- Verification: synthetic spike in a flagged pattern is reflected on the monitoring dashboard.

---

**Coverage note:** These NFRs implement the eleven categories named in Section 36, Deliverable 5.
Several categories (Performance, Availability, Scalability, Disaster recovery) reference concrete
numeric targets that the master spec does not itself specify; those gaps are recorded in
`docs/OPEN_DECISIONS.md` rather than filled with invented numbers, consistent with `CLAUDE.md` rule 5.

*Next phase: Deliverable 6 — System architecture.*
