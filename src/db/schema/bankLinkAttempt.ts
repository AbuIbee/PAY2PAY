import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { businessProfile, personalProfile, userAccount } from "./identity";
import { bankLinkAttemptStatusEnum, profileKindEnum } from "./enums";

/**
 * PAID2YOU — B0-D ADYEN PHASE 2A (final bank-security correction). See `enums.ts`'s
 * `bankLinkAttemptStatusEnum` doc comment for the lifecycle this row tracks.
 *
 * REMOVES Phase 2's before/after stored-token list-difference mechanism entirely at the application
 * layer — `existing_stored_payment_method_ids` is deprecated and no longer read or written by any
 * code path (see that column's own doc comment below for why it stays physically present rather than
 * being dropped). Token attribution is never inferred from list changes, timestamps, or token count.
 * Instead, this row is the durable anchor for a webhook-only, Adyen-authenticated correlation chain:
 *
 *   1. `providerSessionId` (Adyen's own `/sessions` id) and `merchantReference` (the `reference` this
 *      server itself chose and passed to `/sessions`) are both set at initiation, server-side only.
 *   2. When Adyen's Standard notification webhook delivers an AUTHORISATION event whose OWN
 *      `merchantReference` matches this row's `merchantReference` (a core, always-present, HMAC-signed
 *      webhook field — never client-suppliable), that event's `pspReference` is recorded here as
 *      `confirmedPspReference`, and `status` advances to "authorised". This is the "originating
 *      transaction reference" — proof, independent of anything the client claims, that THIS specific
 *      session's own $0 authorization attempt actually happened at Adyen.
 *   3. When Adyen's separate Recurring-tokens-lifecycle webhook later delivers
 *      `recurring.token.created`/`recurring.token.alreadyExisting`, its own `eventId` field (Adyen's
 *      own documented "PSP reference of the event that triggered the webhook") is matched against
 *      `confirmedPspReference` here — together with an exact `shopperReference` and `merchantAccount`
 *      match — before the resulting `storedPaymentMethodId` is ever accepted and persisted to
 *      `financial_account`. Never accepted from a lone token event with no matching "authorised" row.
 *
 * The client only ever learns `providerSessionId`/`sessionData` (to mount Adyen's own Component) and
 * later polls this row's own `status` (`BankConnectionService.getBankLinkAttemptStatus`) — it never
 * POSTs anything back that this server would need to trust as proof of completion.
 */
export const bankLinkAttempt = pgTable(
  "bank_link_attempt",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    providerSessionId: text("provider_session_id").notNull().unique(),
    /** This server's own `/sessions` `reference` — the correlation key an incoming AUTHORISATION webhook's own `merchantReference` must match. Never derived from or exposed to anything the client controls. */
    merchantReference: text("merchant_reference").notNull().unique(),
    actingUserId: uuid("acting_user_id")
      .notNull()
      .references(() => userAccount.id),
    partyProfileKind: profileKindEnum("party_profile_kind").notNull(),
    partyIndividualProfileId: uuid("party_individual_profile_id").references(() => personalProfile.id),
    partyOrganizationId: uuid("party_organization_id").references(() => businessProfile.id),
    shopperReference: text("shopper_reference").notNull(),
    /**
     * DEPRECATED (Phase 2A correction) — Phase 2's own before/after stored-token list-difference
     * mechanism. No application code reads or writes this column any more (grep confirms zero
     * references outside this declaration and its own migration). Kept as a nullable, physically
     * present column rather than dropped: `scripts/check-migration-safety.mjs` treats `DROP COLUMN`
     * as a destructive operation requiring explicit Product Owner sign-off, and this project's own
     * documented rollback strategy (docs/OPERATIONS_BACKUP_RECOVERY.md) is additive-only migrations —
     * "add new column/table; deploy code using it; migrate data; remove old structure later." Actually
     * dropping this column is exactly that "later" step, deliberately left for a future migration with
     * its own explicit sign-off, not bundled into this security-fix migration.
     */
    existingStoredPaymentMethodIds: text("existing_stored_payment_method_ids").array(),
    /** Purely cosmetic display label the shopper may enter at initiate time (before anything Adyen-side happens) — never used for any correlation/authorization decision. */
    institutionDisplayName: text("institution_display_name"),
    /** Set only once a matching AUTHORISATION webhook (success:true, merchantReference match) is durably processed — see this table's own doc comment, step 2. Null until then. */
    confirmedPspReference: text("confirmed_psp_reference"),
    status: bankLinkAttemptStatusEnum("status").notNull().default("pending"),
    // Not FK-constrained to avoid a chicken-and-egg ordering requirement at completion time — same
    // "would-be-circular, application-enforced" precedent as agreement.ts's currentVersionId.
    resultFinancialAccountId: uuid("result_financial_account_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "bank_link_attempt_exactly_one_party",
      sql`(${table.partyIndividualProfileId} IS NOT NULL AND ${table.partyOrganizationId} IS NULL) OR (${table.partyIndividualProfileId} IS NULL AND ${table.partyOrganizationId} IS NOT NULL)`,
    ),
  ],
).enableRLS();
