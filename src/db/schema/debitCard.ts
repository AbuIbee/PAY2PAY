import { sql } from "drizzle-orm";
import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agreement } from "./agreement";
import { financialAccount } from "./financialAccount";
import { debitCardMethodStatusEnum, profileKindEnum } from "./enums";

/**
 * Sprint 12 (docs/sprints/SPRINT_12_DebitCard_Sandbox.md): the debit card on file for a specific
 * agreement, mirroring `ach_mandate`'s shape (src/db/schema/ach.ts). `card_token` is an opaque
 * provider-issued reference — this sprint's explicit "Never store full card numbers or CVV." only
 * `card_last4`/`card_brand` are stored as plain columns, which is standard, non-sensitive display
 * metadata (PCI DSS permits storing the last four digits, brand, and expiry outside full PCI scope;
 * this is not cardholder data). Scoped to one agreement, not the payer profile generally, matching
 * `ach_mandate`'s own precedent (a payer may put different cards on file for different debts).
 * Append-only: `replaceCard` never mutates an existing row's card fields — it marks this row
 * "replaced" and inserts a new row linked back via `supersedes_card_method_id`, preserving the full
 * card history the same way `ach_mandate.supersedes_mandate_id` does.
 */
export const debitCardMethod = pgTable("debit_card_method", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  agreementId: uuid("agreement_id")
    .notNull()
    .references(() => agreement.id),
  payerProfileKind: profileKindEnum("payer_profile_kind").notNull(),
  payerProfileId: uuid("payer_profile_id").notNull(),
  cardToken: text("card_token").notNull(),
  cardLast4: text("card_last4").notNull(),
  cardBrand: text("card_brand"),
  expiresAtMonth: integer("expires_at_month").notNull(),
  expiresAtYear: integer("expires_at_year").notNull(),
  status: debitCardMethodStatusEnum("status").notNull().default("active"),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  replacedAt: timestamp("replaced_at", { withTimezone: true }),
  replacedReason: text("replaced_reason"),
  // Set on the *new* card created by replaceCard, pointing back at the card it replaces — same
  // not-FK-constrained precedent as ach_mandate.supersedesMandateId (self-referential FK adds real
  // complexity for zero benefit at this schema's scale).
  supersedesCardMethodId: uuid("supersedes_card_method_id"),
  // Sprint 18A addition: additive, nullable — same precedent as ach.ts's identical
  // `financialAccountId` addition; set only when this card was registered through the relationship
  // flow by reusing a party's already-known `financial_account`.
  financialAccountId: uuid("financial_account_id").references(() => financialAccount.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
