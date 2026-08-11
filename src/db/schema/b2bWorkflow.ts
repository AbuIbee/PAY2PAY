import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agreement } from "./agreement";
import { agreementReferenceTypeEnum } from "./enums";
import { userAccount } from "./identity";

/**
 * Sprint 8 (docs/sprints/SPRINT_08_Workflows_CSVImports.md) B2B workflow completion: "Record:
 * legal entities, authorized signers, titles, signing authority, invoice/PO/contract references."
 * Legal entities are already `business_profile.legal_business_name` (Sprint 3); authorized
 * signers/titles/signing authority are already captured per-signature by Sprint 6's
 * `signature_event.signer_title`/`signing_authority` — neither is duplicated here. This table is
 * only the one genuinely new piece: structured invoice/PO/contract reference numbers, since an
 * agreement can reference more than one (e.g. several invoices settled by one repayment plan).
 */
export const agreementReference = pgTable("agreement_reference", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  agreementId: uuid("agreement_id")
    .notNull()
    .references(() => agreement.id),
  referenceType: agreementReferenceTypeEnum("reference_type").notNull(),
  referenceNumber: text("reference_number").notNull(),
  addedByUserId: uuid("added_by_user_id")
    .notNull()
    .references(() => userAccount.id),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
