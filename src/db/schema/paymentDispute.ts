import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { paymentAttempt } from "./payment";
import { paymentDisputeCategoryEnum, paymentDisputeStatusEnum, profileKindEnum } from "./enums";
import { userAccount } from "./identity";

/**
 * Sprint 16 (docs/sprints/SPRINT_16_Disputes.md): master spec §13/FR-UPAY's payment-level
 * unauthorized-payment claim — a payer-initiated evidentiary record, deliberately separate from
 * `agreement_dispute` ("Do not conflate them," this sprint's own instruction). The state transition
 * itself (`payment_attempt.status` moving through `disputed → refunded | succeeded`) reuses Sprint
 * 9/10's existing webhook-driven mechanics exactly — `PaymentDisputeService.claimUnauthorizedPayment`
 * calls the same `LedgerService.reversePayment`/`PaymentAttemptRepository.updateStatus` the
 * `payment.disputed` webhook already calls, so a claim filed through this table's own flow and a
 * claim the processor reports asynchronously both produce identical ledger/status effects — no
 * second, competing state-transition path.
 *
 * The four `preserved_*` fields are captured once, at claim time, from whatever mandate/signature/
 * identity-verification/network context existed at that moment — "preserve mandate, preserve
 * signatures, preserve identity verification reference, preserve IP/device/timestamp" (this sprint's
 * own instruction, verbatim). They are opaque reference strings (a `ach_mandate`/`debit_card_method`
 * id, a `signature_event` id, an `identity_verification_record` id) rather than foreign keys, since
 * the referenced row may later be revoked/replaced/superseded (all three are themselves append-only —
 * see ach.ts/debitCard.ts's own doc comments) and this snapshot must remain exactly what it was at
 * claim time regardless of what happens to the live row afterward.
 */
export const paymentDispute = pgTable("payment_dispute", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  paymentAttemptId: uuid("payment_attempt_id")
    .notNull()
    .references(() => paymentAttempt.id),
  status: paymentDisputeStatusEnum("status").notNull().default("claimed"),
  category: paymentDisputeCategoryEnum("category").notNull(),
  explanation: text("explanation").notNull(),
  claimedByProfileKind: profileKindEnum("claimed_by_profile_kind").notNull(),
  claimedByProfileId: uuid("claimed_by_profile_id").notNull(),
  claimedByUserId: uuid("claimed_by_user_id")
    .notNull()
    .references(() => userAccount.id),
  preservedMandateReference: text("preserved_mandate_reference"),
  preservedSignatureReference: text("preserved_signature_reference"),
  preservedIdentityVerificationReference: text("preserved_identity_verification_reference"),
  ipAddress: text("ip_address"),
  deviceInfo: jsonb("device_info"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  resolutionNotes: text("resolution_notes"),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => userAccount.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
