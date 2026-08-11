import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agreement, agreementVersion } from "./agreement";
import {
  evidenceDocumentTypeEnum,
  evidenceFileValidationStatusEnum,
  evidenceVisibilityEnum,
  evidenceWithdrawalStateEnum,
} from "./enums";
import { userAccount } from "./identity";

/**
 * Sprint 7 (docs/sprints/SPRINT_07_Evidence_Documents_Witnesses.md) evidence documents. Matches
 * docs/DATA_MODEL.md §4's illustrative `evidence_document` shape, extended with every field this
 * sprint's fuller "Implement:" list names that the illustrative shape didn't already cover
 * (file size/content type for validation, witness-sharing, dispute flag, withdrawal state,
 * validation status) — same "extend the illustrative shape" precedent Sprint 5 set for `agreement`.
 */
export const evidenceDocument = pgTable("evidence_document", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  agreementId: uuid("agreement_id")
    .notNull()
    .references(() => agreement.id),
  uploadedByUserId: uuid("uploaded_by_user_id")
    .notNull()
    .references(() => userAccount.id),
  documentType: evidenceDocumentTypeEnum("document_type").notNull(),
  description: text("description"),
  storagePath: text("storage_path").notNull(),
  documentHash: text("document_hash").notNull(),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  contentType: text("content_type").notNull(),
  // Set once, permanently, at upload time from whether the agreement's current version was already
  // signed at that moment — never recomputed later, so it can never silently drift as the
  // agreement's status changes afterward (FR-EVID-002's "must never appear to have existed before
  // signature" requires this to be a frozen fact about the upload, not a live derived value).
  isPostSigning: boolean("is_post_signing").notNull().default(false),
  visibility: evidenceVisibilityEnum("visibility").notNull().default("shared"),
  sharedWithWitnesses: boolean("shared_with_witnesses").notNull().default(false),
  disputeFlag: boolean("dispute_flag").notNull().default(false),
  withdrawalState: evidenceWithdrawalStateEnum("withdrawal_state").notNull().default("active"),
  fileValidationStatus: evidenceFileValidationStatusEnum("file_validation_status").notNull().default("clean"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * Sprint 7 witnesses. Deliberately one row per (agreement, witness) covering both the access grant
 * and the eventual attestation — this sprint's agreements never have more than one version (Sprint
 * 14/15 add amendments), so there is no real scenario yet requiring one witness to attest to
 * multiple versions of the same agreement; `attestedVersionId` is nullable specifically to
 * distinguish "added, not yet attested" from "attested." Not part of `agreement_party` — a witness
 * is never a creditor or debtor and has no standing in AgreementService at all (see
 * witnessService.ts's doc comment).
 */
export const agreementWitness = pgTable(
  "agreement_witness",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    agreementId: uuid("agreement_id")
      .notNull()
      .references(() => agreement.id),
    witnessUserId: uuid("witness_user_id")
      .notNull()
      .references(() => userAccount.id),
    addedByUserId: uuid("added_by_user_id")
      .notNull()
      .references(() => userAccount.id),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    // "May attest only to exact version" — the specific agreement_version this witness attested to.
    attestedVersionId: uuid("attested_version_id").references(() => agreementVersion.id),
    attestedAt: timestamp("attested_at", { withTimezone: true }),
    ipAddress: text("ip_address"),
    deviceInfo: jsonb("device_info"),
  },
  (table) => [uniqueIndex("agreement_witness_agreement_user_unique").on(table.agreementId, table.witnessUserId)],
).enableRLS();
