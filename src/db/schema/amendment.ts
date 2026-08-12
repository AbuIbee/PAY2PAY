import { sql } from "drizzle-orm";
import { date, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agreement, agreementVersion } from "./agreement";
import {
  agreementPartyRoleEnum,
  amendmentChangeTypeEnum,
  amendmentStatusEnum,
  feeAllocationEnum,
  paymentFrequencyEnum,
  profileKindEnum,
} from "./enums";

/**
 * Sprint 14 (docs/sprints/SPRINT_14_Amendments_Hardship.md): a proposed contractual change,
 * matching `docs/STATE_MACHINES.md` §3's Amendment lifecycle. Deliberately a single table rather
 * than `docs/DATA_MODEL.md` §4's illustrative two-table `amendment` + `hardship_request` split — this
 * sprint's own required-test list (proposal/rejection/counter/dual acceptance/version creation/
 * original preserved/unauthorized change blocked) and instruction text never describe a separate
 * hardship-negotiation-then-handoff layer; the fields master spec §9 requires a hardship request to
 * carry (reason, requested relief, proposed effective date, proposed replacement terms) all live
 * directly on this row instead. See `docs/SPRINT_CONTROL.md`'s "Sprint 14 implementation notes" for
 * the full rationale — nothing master-spec-required is dropped, only the extra indirection layer.
 *
 * `terms`/`frequency`/`fee_allocation` mirror `agreement_version`'s own shape exactly (same
 * `AgreementTerms` type, built through the same `buildTerms`/`computeSchedule` this sprint reuses
 * from `agreementService.ts`) — this row *is* the next version's proposed content until it's
 * actually promoted to one on `Applied`.
 */
export const amendment = pgTable("amendment", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  agreementId: uuid("agreement_id")
    .notNull()
    .references(() => agreement.id),
  changeType: amendmentChangeTypeEnum("change_type").notNull(),
  status: amendmentStatusEnum("status").notNull().default("proposed"),
  // Whichever party currently "holds the ball" — the original proposer, or (after a counter) the
  // countering party. The *other* role is always who may accept/reject/counter next.
  proposingPartyRole: agreementPartyRoleEnum("proposing_party_role").notNull(),
  proposedByProfileKind: profileKindEnum("proposed_by_profile_kind").notNull(),
  proposedByProfileId: uuid("proposed_by_profile_id").notNull(),
  reason: text("reason").notNull(),
  requestedRelief: text("requested_relief"),
  proposedEffectiveDate: date("proposed_effective_date"),
  frequency: paymentFrequencyEnum("frequency").notNull(),
  feeAllocation: feeAllocationEnum("fee_allocation").notNull(),
  terms: jsonb("terms").notNull(),
  creditorSignedAt: timestamp("creditor_signed_at", { withTimezone: true }),
  debtorSignedAt: timestamp("debtor_signed_at", { withTimezone: true }),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  // Set only once, on Applied — the new agreement_version this amendment produced. Never the other
  // way around (agreement_version has no back-reference to the amendment that created it, matching
  // agreement_version.parentVersionId's existing not-FK-constrained self-reference precedent).
  resultingVersionId: uuid("resulting_version_id").references(() => agreementVersion.id),
  rejectedReason: text("rejected_reason"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  withdrawnReason: text("withdrawn_reason"),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
