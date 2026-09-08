import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agreement, installmentScheduleItem } from "./agreement";
import { paymentAttemptStatusEnum, paymentMethodEnum, paymentWebhookEventSourceEnum, paymentWebhookProcessingStatusEnum, profileKindEnum } from "./enums";
import { userAccount } from "./identity";
import { financialAccount } from "./financialAccount";

/**
 * Sprint 9 (docs/sprints/SPRINT_09_PaymentProviderAbstraction _Sandbox.md) payment-provider
 * abstraction. Deliberately narrower than docs/DATA_MODEL.md §4's illustrative `payment_attempt`
 * shape (no `payment_method_id`/`installment_schedule_item_id`/`attempt_kind` — those depend on a
 * payment-method-on-file flow and the ledger/installment linkage that don't exist until Sprint
 * 10-12) — this table exists so PaymentService has somewhere durable to enforce idempotency and
 * record provider-driven state transitions, per this sprint's "Payment records must be
 * append/audit-oriented" and "Preserve idempotency and auditability" requirements. `agreementId` is
 * nullable because this sprint's abstraction is provider/sandbox-scoped, not yet required to be
 * called only from an agreement-installment context.
 *
 * `providerPaymentId` is an external reference column only (never a join key elsewhere), per this
 * sprint's "Treat external/provider IDs as external references, not as primary internal domain
 * identifiers."
 */
export const paymentAttempt = pgTable(
  "payment_attempt",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    idempotencyKey: text("idempotency_key").notNull(),
    payerProfileKind: profileKindEnum("payer_profile_kind").notNull(),
    payerProfileId: uuid("payer_profile_id").notNull(),
    recipientProfileKind: profileKindEnum("recipient_profile_kind").notNull(),
    recipientProfileId: uuid("recipient_profile_id").notNull(),
    amountMinorUnits: integer("amount_minor_units").notNull(),
    currency: text("currency").notNull().default("USD"),
    agreementId: uuid("agreement_id").references(() => agreement.id),
    status: paymentAttemptStatusEnum("status").notNull().default("pending"),
    providerName: text("provider_name").notNull(),
    providerPaymentId: text("provider_payment_id"),
    failureReason: text("failure_reason"),
    // Sprint 10 (docs/sprints/SPRINT_10_InternalFinancialLedger.md) addition: set once, when the
    // ledger's "payout" entry posts (see ledgerService.ts) — never written any other way. Nullable;
    // null means no payout has occurred yet, regardless of payment status.
    payoutCompletedAt: timestamp("payout_completed_at", { withTimezone: true }),
    // Sprint 11 (docs/sprints/SPRINT_11_ACH_Sandbox.md) addition: set when payout is initiated,
    // before it settles — docs/PAYMENT_STATE_MACHINE.md §1's "Cleared → PayoutPending" step.
    // Payout status is derived from these two timestamps rather than a separate enum column,
    // mirroring Sprint 10's own precedent (payoutCompletedAt) rather than overloading the main
    // `status` column with a concern §2 of that doc models as its own lifecycle: null/null = not
    // yet payout-pending, set/null = PayoutPending, set/set = PaidOut.
    payoutInitiatedAt: timestamp("payout_initiated_at", { withTimezone: true }),
    // Sprint 11 addition: which installment this attempt is collecting, per
    // docs/PAYMENT_STATE_MACHINE.md §1's own opening line ("each payment_attempt row is one attempt
    // at collecting one installment") and docs/DATA_MODEL.md §4's illustrative shape. Nullable —
    // Sprint 9's abstraction-level tests and any future extra/settlement payment (Sprint 15+) have
    // no specific installment to link to.
    installmentScheduleItemId: uuid("installment_schedule_item_id").references(() => installmentScheduleItem.id),
    // Sprint 12 (docs/sprints/SPRINT_12_DebitCard_Sandbox.md) addition: which rail this attempt
    // used. Nullable — every pre-Sprint-12 row never set this. See enums.ts's paymentMethodEnum doc
    // comment for why this exists as its own column rather than being inferred from status values.
    paymentMethod: paymentMethodEnum("payment_method"),
    // PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md)
    // addition: which party recorded a "manual_off_platform" attempt (see paymentMethodEnum's
    // updated doc comment) — never set for a provider-routed (ach/debit_card) attempt, since those
    // are always recorded by PaymentService itself, not attributed to one party's own action.
    // Nullable — every pre-PRSprint-18 row has no recorder to attribute.
    recordedByUserId: uuid("recorded_by_user_id").references(() => userAccount.id),
    // PRSprint 18: "optional recipient confirmation for manual payment" — purely evidentiary; the
    // manual payment already counts toward the agreement's balance the moment it's recorded (see
    // PaymentService.recordManualOffPlatformPayment's doc comment for why confirmation is never a
    // gate on that). Nullable — unconfirmed by default, and never applicable to a provider-routed
    // attempt (a real processor's own webhook is already that attempt's confirmation).
    recipientConfirmedAt: timestamp("recipient_confirmed_at", { withTimezone: true }),
    // Phase 6A (docs/prsprints/PHASE_6A_PREPRODUCTION_FINANCIAL_UX_COMPLETION.md) Ledger Payment-
    // Source Rule: "the ledger must identify a payment source using an internal bank_connection_id,
    // never a routing or account number." References the same party-owned `financial_account` row
    // Sprint 18A already built (never a new/duplicate table — see that table's own doc comment for
    // why `financial_account` already models this concept). Nullable: only set for a provider-routed
    // payment that actually used a known bank connection (ACH, once the mandate that authorized it
    // carries a `financial_account_id` — see achMandateFinancialAccountAdapter.ts); null for
    // debit_card/manual_off_platform attempts and for any ACH mandate authorized outside the
    // relationship flow (pre-Phase-6A path, still valid, simply has no known internal bank-connection
    // record to reference). Deliberately NOT FK-constrained to CASCADE on delete — `financial_account`
    // rows are never hard-deleted (disableAccount only ever sets `disabledAt`), so a historical
    // payment's provenance survives a bank connection being disconnected/replaced (this phase's own
    // "a removed bank connection should not make historical payments impossible to understand").
    bankConnectionId: uuid("bank_connection_id").references(() => financialAccount.id),
    // PACKAGE B — PRE-CODEX FINAL CORRECTION (item 3 — lifecycle candidate starvation): set once this
    // EXACT payment attempt's own effect on its agreement's lifecycle has been genuinely examined
    // (`AgreementCompletionService.checkAndAdvance` actually invoked and returned, whether or not it
    // advanced anything) — never re-derived from agreement status, which can legitimately stay
    // "active"/"past_due" forever for a payment that correctly requires no further lifecycle action.
    // Null means "never examined yet" (every pre-existing row, and any row whose examination crashed
    // before completing) — the ONLY state `listLifecycleRepairCandidates` selects on. A row that WAS
    // examined and correctly produced no lifecycle change is marked and permanently excluded from
    // future scheduler batches — a subsequent succeeded payment on the SAME agreement (which changes
    // the aggregate balance `checkAndAdvance` actually reads) is always its OWN fresh row with this
    // column still null, so genuine future lifecycle work is never missed. This is what makes the
    // candidate set self-shrinking: see `listLifecycleRepairCandidates`'s own doc comment for the
    // starvation this closes (a legitimately-still-active agreement's succeeded payment would
    // otherwise re-qualify on every single scheduler run, forever, at the front of the oldest-first
    // ordering, permanently starving batch slots away from genuinely unresolved rows).
    lifecycleCheckedAt: timestamp("lifecycle_checked_at", { withTimezone: true }),
    // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 4B): durable backoff for a
    // financial-repair candidate (missing clearing/reversal entry) whose most recent automatic repair
    // attempt was blocked (no safe evidence yet, or a transient error) — set (now + a bounded
    // interval) so `listMissingClearingCandidates`/`listMissingReversalCandidates` defer it instead of
    // re-selecting the SAME oldest-but-unrepairable rows on every scheduler run, which would starve a
    // later, genuinely-repairable candidate behind them. Null means "never attempted, or due now."
    // Cleared implicitly the moment repair succeeds (the row then drops out of the candidate query
    // entirely, since its ledger entry now exists) — never read once that happens.
    financialRepairNextAttemptAt: timestamp("financial_repair_next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payment_attempt_idempotency_key_unique").on(table.idempotencyKey),
    uniqueIndex("payment_attempt_provider_payment_id_unique").on(table.providerPaymentId),
    // PRSprint 03 (docs/prsprints/PRSPRINT_03_DATABASE_INTEGRITY_STATE_MACHINES.md): a payment
    // attempt of zero or negative amount has no valid business meaning — every creation path
    // already validates this at the zod boundary (see src/lib/agreements/validation.ts's
    // `.positive()` schedule-amount checks), but nothing stopped a future bug in application code
    // from writing a bad row directly. Applied NOT VALID in the migration (not scanned against
    // existing rows here) — see that migration file's own comment for why.
    check("payment_attempt_amount_positive", sql`${table.amountMinorUnits} > 0`),
    // R09 corrective pass (Codex blocker 1): the automatic reconciliation-repair scheduler's
    // bounded candidate query is always "status = 'succeeded' ORDER BY updated_at" — this index
    // keeps that an index scan, never an unbounded full-table scan, as the table grows.
    index("payment_attempt_status_updated_at_idx").on(table.status, table.updatedAt),
    // PACKAGE B — PRE-CODEX FINAL CORRECTION (item 3): backs `listLifecycleRepairCandidates`'s
    // "status = 'succeeded' AND lifecycle_checked_at IS NULL ORDER BY updated_at" scan.
    index("payment_attempt_lifecycle_checked_idx").on(table.status, table.lifecycleCheckedAt, table.updatedAt),
    // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 4B): backs
    // `listMissingClearingCandidates`/`listMissingReversalCandidates`'s bounded, backoff-aware scan.
    index("payment_attempt_financial_repair_idx").on(table.status, table.financialRepairNextAttemptAt, table.updatedAt),
  ],
).enableRLS();

/**
 * Sprint 9 webhook idempotency/replay-protection ledger for the payment provider specifically
 * (kept separate from `kyc_webhook_event` — this sprint's text: "do not merge the two
 * interfaces," extended here to their event tables too). Every inbound webhook, valid or not,
 * that passes signature verification gets exactly one row keyed by (provider, provider_event_id);
 * a redelivered/replayed event is detected by that unique constraint before ever being reapplied.
 * `processedAt` is null until the event's business-logic effect (a payment_attempt status
 * transition) has been applied, supporting this sprint's "asynchronous processing" requirement
 * without requiring a real job queue to exist yet.
 *
 * R06 (webhook processed-state / redelivery recovery) — corrective pass: `processedAt` alone could
 * never distinguish "merely received" from "fully processed" — a crash between the insert above and
 * the effect being applied left a row that looked identical to a legitimately-pending one, and the
 * unique constraint alone made a redelivery of that exact event resolve as "duplicate" even though
 * nothing had actually been applied yet (see PaymentWebhookEventRepository's own doc comment for the
 * full defect). The columns below make the processing lifecycle durable and explicit — see
 * `paymentWebhookProcessingStatusEnum`'s own doc comment for the state vocabulary — so a claim/lease
 * operation can authoritatively answer "is this event safe to (re)claim right now?" without ever
 * treating existence as completion. `processedAt` itself is kept, unchanged in meaning, purely for
 * backward-compatible reads and historical queries; `processingStatus` is now the authoritative field.
 */
export const paymentWebhookEvent = pgTable(
  "payment_webhook_event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    signatureVerified: boolean("signature_verified").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    // R06 additions — all additive/nullable-or-defaulted, safe against every existing row (see the
    // migration's own backfill comment for exactly how a pre-existing row maps onto this vocabulary).
    processingStatus: paymentWebhookProcessingStatusEnum("processing_status").notNull().default("received"),
    processingAttempts: integer("processing_attempts").notNull().default(0),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
    // Sanitized, non-sensitive operational diagnostic only (an error *code*, e.g.
    // "ledger_posting_failed" — never a raw exception message/stack, never provider secrets/PII; see
    // classifyProcessingFailure in paymentWebhookService.ts for the fixed vocabulary this is drawn
    // from).
    lastErrorCode: text("last_error_code"),
    // Set only on a retryable failure — when to next attempt this event (bounded exponential
    // backoff). Null for "received" (immediately eligible), "processing" (not applicable — the lease
    // governs it), "processed" (nothing more to do), and a permanent/poison "failed" (never retried
    // again; distinguishes a poison event from a retryable one within the same "failed" status).
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    // Set whenever a worker claims this event for processing; a claim is only valid while this is in
    // the future — once it lapses, the claim is considered abandoned (worker crashed / process died)
    // and the event becomes safely reclaimable by any worker, closing the "a crashed worker must not
    // wedge the event forever" requirement.
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    // R06 corrective pass (Codex blocker 2 — claim fencing): a fresh, unique token generated on
    // EVERY successful claim (first insert, or any later reclaim). Every finalization write
    // (markProcessed/markFailedRetryable/markFailedPermanent) is conditioned on `id AND
    // claim_token` matching, never `id` alone — a worker whose lease has since expired and been
    // reclaimed by someone else is holding a now-stale token, so its own finalization attempt
    // matches zero rows and is silently, safely ignored rather than overwriting the new owner's
    // result. See PaymentWebhookService's own doc comment for the full scenario this closes.
    claimToken: uuid("claim_token"),
    // R09 corrective pass (Codex blocker 8 — reconciliation evidence): extracted from the payload
    // at claim time so automatic repair can look up "the trusted, processed event(s) for this exact
    // provider+providerPaymentId+eventType" via a real index instead of `listAll()` + in-memory
    // filtering. Nullable — not every event payload names a providerPaymentId (e.g. a malformed one).
    providerPaymentId: text("provider_payment_id"),
    // PACKAGE B — remaining Codex blockers (durable provider-event transition progress): the
    // durable answer to "did THIS EXACT event's own payment-status transition actually apply?" —
    // the central gap the prior corrective passes left open. `transitionAppliedAt` is the boolean
    // marker (null = never applied — either not yet attempted, or attempted and legally rejected;
    // set = applied, durably, exactly once). `transitionFromStatus`/`transitionToStatus` are written
    // atomically alongside it (see PaymentTransitionCoordinator) so a later retry's required audit
    // effect can reconstruct the exact transition this event caused WITHOUT ever inferring it from
    // whatever the payment's CURRENT status happens to be (which may have moved on since). All three
    // are nullable/additive: every pre-existing row (including every historical "processed" event)
    // gets NULL here, not a fabricated value — those events predate this guarantee and must NOT be
    // assumed to have had every required effect completed merely because they were marked processed
    // under the old model; they remain ordinary bounded-reconciliation candidates instead.
    transitionAppliedAt: timestamp("transition_applied_at", { withTimezone: true }),
    transitionFromStatus: paymentAttemptStatusEnum("transition_from_status"),
    transitionToStatus: paymentAttemptStatusEnum("transition_to_status"),
    // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B2 — Part A): see
    // `paymentWebhookEventSourceEnum`'s own doc comment for the exact provenance model and why
    // `signature_verified` alone cannot express it. Additive, NOT NULL with a "webhook" default —
    // provably correct for every pre-existing row (see that enum's own doc comment for why).
    source: paymentWebhookEventSourceEnum("source").notNull().default("webhook"),
  },
  (table) => [
    uniqueIndex("payment_webhook_event_provider_event_unique").on(table.provider, table.providerEventId),
    // R06: the recovery scheduler's scan predicate is always "processing_status IN (...) AND
    // (next_retry_at/lease_expires_at <= now())" — this composite index keeps that a fast, bounded
    // index scan rather than a full-table scan as the table grows (required: "no unlimited full-table
    // scan in a request").
    index("payment_webhook_event_recovery_scan_idx").on(table.processingStatus, table.nextRetryAt, table.leaseExpiresAt),
    // R09 corrective pass (Codex blocker 8): the automatic-repair evidence lookup's exact predicate —
    // an index scan, never listAll().
    index("payment_webhook_event_trusted_lookup_idx").on(table.provider, table.providerPaymentId, table.eventType, table.processingStatus),
  ],
).enableRLS();
