import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agreement } from "./agreement";
import { agreementCancellationRequestStatusEnum, agreementPartyRoleEnum, profileKindEnum } from "./enums";

/**
 * Mutual cancellation (mandatory command): a request to cancel an already-active agreement. Either
 * party may request it (`requestingPartyRole`, mirroring `amendment.proposing_party_role`'s
 * either-party precedent); the counterparty must accept or reject — see enums.ts's own doc comment
 * for why this is a distinct, post-execution concept from `AgreementService.cancelAgreement`'s
 * pre-signature unilateral withdraw. Accepting writes `agreement.status = 'mutually_canceled'` (the
 * same terminal status `cancelAgreement` already uses — no new agreement status needed); rejecting
 * leaves the agreement untouched and simply closes this request. At most one `pending` request may
 * exist per agreement at a time (enforced in `AgreementCancellationService`, not a DB constraint —
 * mirrors this codebase's established "the service is the sole authority" precedent for every other
 * propose/decide table here).
 */
export const agreementCancellationRequest = pgTable("agreement_cancellation_request", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  agreementId: uuid("agreement_id")
    .notNull()
    .references(() => agreement.id),
  status: agreementCancellationRequestStatusEnum("status").notNull().default("pending"),
  requestedByPartyRole: agreementPartyRoleEnum("requested_by_party_role").notNull(),
  requestedByProfileKind: profileKindEnum("requested_by_profile_kind").notNull(),
  requestedByProfileId: uuid("requested_by_profile_id").notNull(),
  reason: text("reason").notNull(),
  decidedByProfileKind: profileKindEnum("decided_by_profile_kind"),
  decidedByProfileId: uuid("decided_by_profile_id"),
  rejectedReason: text("rejected_reason"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
