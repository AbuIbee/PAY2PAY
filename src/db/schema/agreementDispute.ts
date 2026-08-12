import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agreement } from "./agreement";
import { amendment } from "./amendment";
import { agreementDisputeCategoryEnum, agreementDisputeStatusEnum, agreementPartyRoleEnum, profileKindEnum } from "./enums";
import { userAccount } from "./identity";

/**
 * Sprint 16 (docs/sprints/SPRINT_16_Disputes.md): master spec §13's agreement-level dispute —
 * "either party may dispute the debt's existence, amount, evidence, payment status, or agreement
 * administration," carrying "written explanation, dispute category, supporting evidence when
 * available," with the counterparty able to "respond and upload evidence." Evidence itself is never
 * duplicated onto this table — `evidence_document.dispute_flag` (Sprint 7) is reused via
 * `EvidenceService.setDisputeFlag`, so a dispute's evidence is simply "this agreement's evidence
 * documents currently flagged," never a second, parallel evidence store.
 *
 * "Scheduled payments continue unless authorization is revoked, both parties agree to pause, or
 * processor/admin restriction applies" (this sprint's own instruction, matching
 * `docs/STATE_MACHINES.md` §7's "scheduled payments are not blocked by Opened/UnderReview status
 * alone") is enforced by construction: nothing in `AgreementDisputeService` ever touches
 * `agreement.status`, a payment schedule, or a mandate/card-on-file — the one status value with any
 * real-world payment-blocking implication (`restricted`) is a structural hook for a future sprint's
 * scheduling code to consult, not something this sprint's own payment services check yet (documented
 * scope boundary, see `docs/SPRINT_CONTROL.md`'s Sprint 16 implementation notes).
 */
export const agreementDispute = pgTable("agreement_dispute", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  agreementId: uuid("agreement_id")
    .notNull()
    .references(() => agreement.id),
  status: agreementDisputeStatusEnum("status").notNull().default("opened"),
  category: agreementDisputeCategoryEnum("category").notNull(),
  explanation: text("explanation").notNull(),
  raisedByRole: agreementPartyRoleEnum("raised_by_role").notNull(),
  raisedByProfileKind: profileKindEnum("raised_by_profile_kind").notNull(),
  raisedByProfileId: uuid("raised_by_profile_id").notNull(),
  raisedByUserId: uuid("raised_by_user_id")
    .notNull()
    .references(() => userAccount.id),
  response: text("response"),
  respondedByUserId: uuid("responded_by_user_id").references(() => userAccount.id),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  resolutionNotes: text("resolution_notes"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  // Set only by resolveWithAmendment — see this table's own doc comment on the resolved_with_amendment/AmendmentInProgress collapse.
  resultingAmendmentId: uuid("resulting_amendment_id").references(() => amendment.id),
  restrictedReason: text("restricted_reason"),
  restrictedByUserId: uuid("restricted_by_user_id").references(() => userAccount.id),
  restrictedAt: timestamp("restricted_at", { withTimezone: true }),
  restrictionLiftedAt: timestamp("restriction_lifted_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
