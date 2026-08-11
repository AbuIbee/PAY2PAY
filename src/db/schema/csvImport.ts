import { sql } from "drizzle-orm";
import { date, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agreement } from "./agreement";
import {
  csvImportBatchStatusEnum,
  csvImportRowDuplicateStatusEnum,
  csvImportRowValidationStatusEnum,
  paymentFrequencyEnum,
} from "./enums";
import { businessProfile, userAccount } from "./identity";

/**
 * Sprint 8 (docs/sprints/SPRINT_08_Workflows_CSVImports.md) CSV import: UPLOAD, VALIDATE, PREVIEW,
 * DUPLICATE CHECK, ERROR REPORT, CREATE DRAFTS. One batch per uploaded file.
 */
export const csvImportBatch = pgTable("csv_import_batch", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  businessProfileId: uuid("business_profile_id")
    .notNull()
    .references(() => businessProfile.id),
  uploadedByUserId: uuid("uploaded_by_user_id")
    .notNull()
    .references(() => userAccount.id),
  fileName: text("file_name").notNull(),
  status: csvImportBatchStatusEnum("status").notNull().default("uploaded"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * One row per CSV line. "Support drafts for: customers, invoices, balances, proposed plans" —
 * every field a real draft agreement eventually needs, captured up front so validation can run
 * against the exact same rules `AgreementService`/`computeSchedule` (Sprint 5) already enforce,
 * before ever attempting to create a real agreement. `createdDraftAgreementId` stays null until
 * (and unless) `createDrafts` successfully turns this row into a real, individual `draft`-status
 * agreement — "Never bulk activate" is structural: this column can only ever point at an agreement
 * whose own status starts at `draft` and is never advanced by this sprint's code.
 */
export const csvImportRow = pgTable("csv_import_row", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => csvImportBatch.id),
  rowNumber: integer("row_number").notNull(),
  customerEmail: text("customer_email").notNull(),
  customerName: text("customer_name").notNull(),
  invoiceReference: text("invoice_reference"),
  balanceMinorUnits: integer("balance_minor_units").notNull(),
  proposedInstallmentAmountMinorUnits: integer("proposed_installment_amount_minor_units").notNull(),
  proposedFrequency: paymentFrequencyEnum("proposed_frequency").notNull(),
  proposedFirstPaymentDate: date("proposed_first_payment_date").notNull(),
  validationStatus: csvImportRowValidationStatusEnum("validation_status").notNull().default("pending"),
  validationErrors: jsonb("validation_errors"),
  duplicateStatus: csvImportRowDuplicateStatusEnum("duplicate_status").notNull().default("unique"),
  createdDraftAgreementId: uuid("created_draft_agreement_id").references(() => agreement.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
