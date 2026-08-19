# PAY2PAY Data Retention & Deletion — Technical Architecture

PRSprint 32 (docs/prsprints/PRSPRINT_32_COMPLIANCE_HOOKS_CONSENT_PRIVACY_RETENTION.md), master-spec
items 114-115. **This document describes architecture, not a legal conclusion** — the same framing
`docs/COMPLIANCE_REVIEW_CHECKLIST.md` uses throughout, and for the identical reason: nothing here
should be read as, or represented to a user, investor, or regulator as, legal advice about what
retention periods actually satisfy applicable law. Item L10 of that checklist ("Data retention... §28
mandates a specific 7-year baseline... whether 7 years satisfies every applicable record-retention
statute is a legal question") is **Not yet reviewed**, and remains not yet reviewed after this
document.

## 1. What mechanism actually governs retention today

Two things exist; a third — the piece that would actually delete anything — does not:

1. **Nothing is ever hard-deleted.** Every domain table in this codebase (agreements, versions,
   signatures, payments, ledger entries, audit events, evidence/documents, notification history)
   uses status transitions or soft markers, never row deletion, for every state change this project
   has built. This is not a retention *feature* — it is simply how every service in this codebase has
   been written from Sprint 5 onward (see e.g. `agreementService.ts`, `ledgerService.ts`: `updateStatus`,
   never `DELETE`).
2. **`RetentionHoldService`** (`src/lib/admin/retentionHoldService.ts`, PRSprint 07/Sprint 18) can place
   an append-only hold (`retention`, `dispute`, `fraud_review`, `litigation`, `administrative_override`)
   on any resource (`targetResourceType`/`targetResourceId` — works for an agreement, a user account, or
   any future resource type without a schema change), and exposes `hasActiveHold(type, id)` as the
   yes/no check any future deletion job must consult first.
3. **No scheduled deletion/minimization job exists anywhere in this codebase.** `RetentionHoldService`'s
   own doc comment says this explicitly: "the hold mechanism itself [is] fully correct and ready, but
   `hasActiveHold` has no real caller enforcing it end-to-end yet." Nothing currently purges data on any
   timer, 7-year or otherwise — so today, in practice, retention is indefinite for every record.

## 2. Retention categories (master-spec item 114's own list)

| Category | Current handling | Retention-relevant fields | Purge job? |
|---|---|---|---|
| Agreements (and versions) | Status transitions only (`draft` → ... → `closed`), full version history kept forever | `agreement.status`, `agreement.closedAt`, `agreement_version` rows | None |
| Signatures | Immutable signature-event rows, tamper-evident hash chain (PRSprint 12) | `signature_event.signedAt`, `documentHash` | None |
| Audit records | Append-only `audit_event` table; every admin/security/financial action logged | `audit_event.occurredAt` | None |
| Payments / ledger | Append-only `ledger_journal_entry`/`ledger_posting`; reversals are new entries, never edits (PRSprint 20's idempotency work depends on this) | `payment_attempt`, `ledger_journal_entry.createdAt` | None |
| Communications | `notification_event`/delivery-attempt records kept indefinitely (PRSprint 13-16) | `notification_event.createdAt` | None |
| Identity/KYC metadata | Provider-tokenized where possible (never raw PAN/CVV/PIN — PRSprint 22/24); verification decision records kept | `identity_verification_record` | None |
| Documents (agreement PDFs, evidence) | Private Supabase Storage buckets, signed-URL access only, never public (PRSprint 06/07) | Storage object timestamps | None |

Every row in every category above is retrievable by `RetentionHoldService.hasActiveHold` today — a
future purge job can be written against exactly this interface without a schema change. What that job
should actually do (what age threshold, whether 7 years per the master spec's own baseline, how it
reconciles with backup lifecycle — `docs/OPERATIONS_BACKUP_RECOVERY.md` already flags "backup-lifecycle
reconciliation with these fields... not fully specified" as open decision #15) is unbuilt and requires
a Product Owner + legal decision on the actual policy before implementation, not a Claude judgment call.

## 3. Account deletion (item 115)

**No self-service "delete my account" feature exists in this product today.** There is nothing to make
inaccurate yet. When one is built, it must:

- Never perform a hard delete of financial/legal records (agreements, payments, signatures, audit
  events) — those categories above are exactly the ones item 115 warns a deletion request "cannot
  necessarily erase."
- Check `RetentionHoldService.hasActiveHold` for every affected resource before doing anything
  irreversible, and block on any active hold.
- Distinguish, in its own UI copy, between what the user's request actually does (e.g., deactivate
  login, remove from active staff rosters, stop new communications) and what it does not do (erase
  historical financial/legal records) — matching master-spec item 113's "suspension vs. deletion are
  different" distinction, which `AdminService.suspendUser`/`reactivateUser` already models correctly
  for admin-initiated suspension.

## 4. Data minimization (item 116) — confirmed, not newly built

Already-established patterns, confirmed via this PRSprint's own audit rather than assumed:

- No CVV, PIN, or full PAN is ever stored — card issuance (PRSprint 24) stores only provider tokens,
  last-four, brand, and expiration.
- No online banking password is ever collected — bank linking (Phase 6A) uses provider-hosted
  tokenized linking, storing only a `bank_connection_id` reference.
- Business/identity verification (PRSprint 22) wraps a to-be-selected provider rather than collecting
  and storing raw SSN/EIN/government-ID data directly in this codebase's own tables.

## 5. What this document does not do

It does not decide a retention period, does not build a purge job, and does not draft user-facing
retention/deletion policy language for the eventual Privacy Policy — all three are legal-review-gated
per `docs/COMPLIANCE_REVIEW_CHECKLIST.md` item L10 and remain open. It documents, honestly, that the
*mechanism* to enforce whatever period is eventually decided (holds, status-transition-only tables,
never-delete-by-default) is already in place and ready for that future job to be built against.
