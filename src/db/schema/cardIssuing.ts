import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businessProfile, personalProfile, userAccount } from "./identity";
import { cardTransactionEventTypeEnum, issuedCardStatusEnum, issuedCardTypeEnum } from "./enums";

/**
 * PRSprint 24 (docs/prsprints/PRSPRINT_24_DEBIT_CARD_ISSUANCE_CARD_LIFECYCLE.md): a PAY2PAY-issued
 * debit card, held by a party so they can spend funds they've received — a genuinely different
 * concept from Sprint 12's `debit_card_method` (a card the *debtor* registers so PAY2PAY can charge
 * it). Party-scoped (individual XOR business, mirroring `financial_account`'s exactly-one-party CHECK
 * pattern), not agreement-scoped — a creditor receiving funds across multiple agreements holds one
 * card, not one per agreement, matching how a real card-issuing product works.
 *
 * `provider_card_ref` is the provider's own opaque card-object reference — never a PAN, CVV, or PIN
 * (this PRSprint's Hard Stop: "card-on-file is not debit-card issuance"; SPRINT_18C_PRODUCTION_READY.md
 * item 31/32: "Never store CVV... Avoid storing full PAN whenever possible... Use provider-hosted/
 * tokenized card components"). `card_last4`/`card_brand`/expiry are the same non-sensitive display
 * metadata `debit_card_method` already established as safe (PCI DSS permits storing these outside
 * full PCI scope) — populated only once the provider confirms issuance (nullable until then).
 *
 * Append-only lifecycle, mirroring `ach_mandate`/`debit_card_method`'s identical precedent:
 * `reportLostOrStolen`/`replace` never mutate an existing row's card fields — they mark this row
 * lost/stolen/replaced and insert a new row linked back via `supersedes_card_id`.
 */
export const issuedCard = pgTable(
  "issued_card",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // PRSprint 24 required negative test: "duplicate issuance request" — mirrors
    // payment_attempt.idempotency_key exactly (required, unique; CardService re-checks on conflict,
    // same insert-then-recheck pattern as PaymentService.reserveAttempt).
    idempotencyKey: text("idempotency_key").notNull(),
    individualProfileId: uuid("individual_profile_id").references(() => personalProfile.id),
    organizationId: uuid("organization_id").references(() => businessProfile.id),
    cardType: issuedCardTypeEnum("card_type").notNull(),
    providerName: text("provider_name").notNull(),
    // Null until the provider confirms the card object exists (status moves past "pending_issuance").
    providerCardRef: text("provider_card_ref"),
    cardLast4: text("card_last4"),
    cardBrand: text("card_brand"),
    expiresAtMonth: integer("expires_at_month"),
    expiresAtYear: integer("expires_at_year"),
    status: issuedCardStatusEnum("status").notNull().default("requested"),
    // Only meaningful for a physical card — never collected for a virtual-only card.
    shippingAddress: jsonb("shipping_address"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    frozenReason: text("frozen_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedReason: text("closed_reason"),
    // Set on the *new* card created by reportLostOrStolen/replace, pointing back at the card it
    // replaces — same not-FK-constrained, application-enforced precedent as ach_mandate.
    // supersedesMandateId / debit_card_method.supersedes_card_method_id.
    supersedesCardId: uuid("supersedes_card_id"),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => userAccount.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("issued_card_idempotency_key_unique").on(table.idempotencyKey),
    check(
      "issued_card_exactly_one_party",
      sql`(${table.individualProfileId} IS NOT NULL AND ${table.organizationId} IS NULL) OR (${table.individualProfileId} IS NULL AND ${table.organizationId} IS NOT NULL)`,
    ),
  ],
).enableRLS();

/**
 * PRSprint 24: provider-driven card-transaction lifecycle (authorization -> clearing -> settlement,
 * or decline/reversal) — SPRINT_18C_PRODUCTION_READY.md item 107 ("Do not treat card authorization as
 * final settlement") and item 108 ("Reversals should not delete history"). Deliberately never posts a
 * Phase 5 ledger entry: a card transaction spends funds *already paid out* to the cardholder outside
 * PAY2PAY's own payer-to-creditor obligation tracking — recording it here is for visibility/support/
 * reconciliation (item 109), not a second money-movement path through the authoritative ledger (this
 * phase's own "Provider -> PAY2PAY source-of-truth rule": the provider is authoritative for what
 * happened in its own infrastructure; a card purchase never affects any agreement's obligation).
 * Append-only — no update/delete method exists on its repository, matching every other event-ledger
 * table in this codebase (`payment_webhook_event`, `kyc_webhook_event`).
 */
export const cardTransactionEvent = pgTable(
  "card_transaction_event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    issuedCardId: uuid("issued_card_id")
      .notNull()
      .references(() => issuedCard.id),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: cardTransactionEventTypeEnum("event_type").notNull(),
    providerTransactionRef: text("provider_transaction_ref").notNull(),
    amountMinorUnits: integer("amount_minor_units").notNull(),
    currency: text("currency").notNull().default("USD"),
    merchantDisplayName: text("merchant_display_name"),
    signatureVerified: boolean("signature_verified").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("card_transaction_event_provider_event_unique").on(table.provider, table.providerEventId),
    check("card_transaction_event_amount_positive", sql`${table.amountMinorUnits} > 0`),
  ],
).enableRLS();
