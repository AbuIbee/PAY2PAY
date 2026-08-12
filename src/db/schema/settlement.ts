import { sql } from "drizzle-orm";
import { date, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agreement } from "./agreement";
import { paymentAttempt } from "./payment";
import {
  agreementPartyRoleEnum,
  profileKindEnum,
  settlementFailureConsequenceEnum,
  settlementPaymentModeEnum,
  settlementProposalStatusEnum,
} from "./enums";

/**
 * Sprint 15 (docs/sprints/SPRINT_15_ PartialPayments_Settlement.md): master spec §12's settlement.
 * Carries every field §12 requires the settlement to state — pre-settlement balance, settlement
 * amount, forgiven amount, deadline, payment mode, and the failure consequence chosen at proposal
 * time (never substituted at failure time, per `docs/STATE_MACHINES.md` §6's own invalid-transition
 * note). `failure_consequence_stated_amount_minor_units` is the one amount `restore_stated`/
 * `forgive_permanently` need at proposal time; which of the two it means is disambiguated by
 * `failure_consequence` itself. `resolved_*` columns are written once, only by
 * `SettlementService`'s failure-consequence resolution, and never by the proposal/decision path.
 *
 * Either party may propose (master spec §12: "the creditor and borrower may mutually agree"),
 * unlike partial payment's borrower-only proposal — mirrors `amendment.proposing_party_role`'s
 * flexible-proposer precedent exactly, including the same counter-offer flip semantics.
 *
 * No signature phase and no hand-off to `AmendmentService`/a new `agreement_version`: this sprint's
 * instruction text never mentions one (unlike Sprint 14's amendments, which are explicitly dual-
 * signed), so `proposed → accepted → awaiting_payment` is this table's own self-contained
 * negotiation, collapsing `docs/STATE_MACHINES.md` §6's illustrative `AmendmentInProgress` sub-phase
 * — see `docs/SPRINT_CONTROL.md`'s Sprint 15 implementation notes for the full rationale, including
 * the one open observation this collapsing surfaces (a creditor-*proposed* settlement that the
 * debtor accepts never passes through the creditor's own step-up gate).
 */
export const settlementProposal = pgTable("settlement_proposal", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  agreementId: uuid("agreement_id")
    .notNull()
    .references(() => agreement.id),
  status: settlementProposalStatusEnum("status").notNull().default("proposed"),
  proposingPartyRole: agreementPartyRoleEnum("proposing_party_role").notNull(),
  proposedByProfileKind: profileKindEnum("proposed_by_profile_kind").notNull(),
  proposedByProfileId: uuid("proposed_by_profile_id").notNull(),
  preSettlementBalanceMinorUnits: integer("pre_settlement_balance_minor_units").notNull(),
  settlementAmountMinorUnits: integer("settlement_amount_minor_units").notNull(),
  forgivenAmountMinorUnits: integer("forgiven_amount_minor_units").notNull(),
  deadline: date("deadline").notNull(),
  paymentMode: settlementPaymentModeEnum("payment_mode").notNull(),
  failureConsequence: settlementFailureConsequenceEnum("failure_consequence").notNull(),
  // Required (validated in SettlementService) only for restore_stated/forgive_permanently.
  failureConsequenceStatedAmountMinorUnits: integer("failure_consequence_stated_amount_minor_units"),
  rejectedReason: text("rejected_reason"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Written once, only by the failure-consequence resolution path (expireOverdueSettlements).
  resolvedConsequence: settlementFailureConsequenceEnum("resolved_consequence"),
  resolvedRestoredBalanceMinorUnits: integer("resolved_restored_balance_minor_units"),
  resolvedForgivenAmountMinorUnits: integer("resolved_forgiven_amount_minor_units"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * Sprint 15: links each succeeded `payment_attempt` collected toward a settlement (one-time or
 * scheduled — §12 requires supporting both) so `SettlementService` can sum cleared amounts against
 * `settlement_amount_minor_units` without re-deriving it from the ledger. A `payment_attempt` is
 * never linked to more than one settlement (the unique index), and `SettlementService` never links
 * one whose status isn't `succeeded`.
 */
export const settlementPayment = pgTable(
  "settlement_payment",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    settlementProposalId: uuid("settlement_proposal_id")
      .notNull()
      .references(() => settlementProposal.id),
    paymentAttemptId: uuid("payment_attempt_id")
      .notNull()
      .references(() => paymentAttempt.id),
    amountMinorUnits: integer("amount_minor_units").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("settlement_payment_payment_attempt_id_unique").on(table.paymentAttemptId)],
).enableRLS();
