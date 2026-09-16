import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agreement } from "./agreement";
import { paymentAttempt } from "./payment";
import { payoutAttemptStatusEnum } from "./enums";

/**
 * PAID2YOU — B0-D PHASE 3A (eliminate fictional payouts). Before this table existed, "was this
 * creditor actually paid" was answered ENTIRELY by `payment_attempt.payoutCompletedAt` — a flag that
 * could be (and, via the now-removed `payout.paid` webhook branch, WAS) set the instant a bare webhook
 * event arrived claiming that event type, with no live payout provider ever having been called, no
 * transfer reference, no verifiable evidence of any kind. `LedgerService.postPayout` itself only ever
 * moves an INTERNAL bookkeeping entry (`creditor_proceeds_payable` -> `processor_clearing`) — it has
 * never called any `PaymentProvider` method that could move a real dollar. Marking a payout "completed"
 * from that alone is exactly the fictional-completion defect this table exists to structurally close.
 *
 * This row is the durable, provider-independent anchor for a real payout's lifecycle — one row per
 * `payment_attempt` that owes a creditor a payout, created in `"pending"` the moment that payment's own
 * `payment_cleared` ledger entry posts (see `PaymentWebhookService`'s own doc comment). It NEVER itself
 * calls any provider — that integration does not exist yet (B0-D: no Adyen account, no Balance
 * Platform/Legal Entity Management/Transfers API wiring). Its entire purpose in THIS phase is to make
 * "payout owed but not yet confirmed" a durable, queryable, HONEST fact — see `PayoutService`'s own doc
 * comment (src/lib/payouts/payoutService.ts) for the complete state-machine contract
 * (`pending -> confirmed | failed`, `confirmed -> returned`) and exactly which transitions are, and are
 * not, reachable by any code path today.
 */
export const payoutAttempt = pgTable(
  "payout_attempt",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    paymentAttemptId: uuid("payment_attempt_id")
      .notNull()
      .references(() => paymentAttempt.id),
    agreementId: uuid("agreement_id")
      .notNull()
      .references(() => agreement.id),
    status: payoutAttemptStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set only by `PayoutService.confirmPayout`, together with `providerName`/`providerPayoutReference` — never any other way. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** The provider that reported this payout complete — e.g. "adyen". Never set without `providerPayoutReference` also being set. */
    providerName: text("provider_name"),
    /** The provider's own authoritative transfer/payout identifier — the concrete "verified evidence" this whole table exists to require before a payout may ever be marked confirmed. */
    providerPayoutReference: text("provider_payout_reference"),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    returnReason: text("return_reason"),
  },
  (table) => [uniqueIndex("payout_attempt_payment_attempt_id_unique").on(table.paymentAttemptId)],
).enableRLS();
