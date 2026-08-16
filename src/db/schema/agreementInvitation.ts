import { sql } from "drizzle-orm";
import { integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agreementPartyRoleEnum, feeAllocationEnum, paymentFrequencyEnum, profileKindEnum } from "./enums";
import { agreement } from "./agreement";
import { userAccount } from "./identity";

/**
 * PRSprint 10 (docs/prsprints/PRSPRINT_10_INVITATION_IDENTITY_CLAIMING_ACCEPTANCE.md): the
 * anonymous-review invitation lifecycle. `pending` (created, not yet opened) -> `viewed`
 * (opened at least once — informational only, per this PRSprint's own "do not rely on opened_at
 * as proof of a human view"; never gates or blocks any subsequent action) -> exactly one of
 * `accepted` | `declined` | `expired` | `revoked` (all terminal — see
 * `agreementInvitationService.ts`'s own state-machine comment for the full transition table).
 */
export const agreementInvitationStatusEnum = pgEnum("agreement_invitation_status", [
  "pending",
  "viewed",
  "accepted",
  "declined",
  "expired",
  "revoked",
]);

/**
 * PRSprint 10: a canonical `agreement` row (Sprint 5) requires a real, already-existing profile on
 * both sides (`creditorProfileId`/`debtorProfileId` are `NOT NULL`) — deliberately left untouched
 * here (PRSprint 09 just re-confirmed that table's canonical, single-row-per-agreement model is
 * load-bearing for every downstream consumer: ledger, payments, admin, disputes). A not-yet-
 * registered recipient has no profile at all, so the proposed terms live *here*, on the invitation
 * itself — the same "closed-vocabulary fields get real typed columns, the rest is a JSONB
 * required-field-set snapshot" pattern `agreement_version.terms` already established (see
 * agreement.ts) — and a real `agreement` + `agreement_version` is created only once the recipient
 * has bound a real profile (`agreementInvitationService.ts`'s `acceptPlan`), at which point
 * `agreementId` is set. Every pre-acceptance field here is mutable (an unsigned proposal); nothing
 * on `agreement`/`agreement_version` is ever touched before that point.
 */
export const agreementInvitation = pgTable(
  "agreement_invitation",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    inviterUserId: uuid("inviter_user_id")
      .notNull()
      .references(() => userAccount.id),
    inviterProfileKind: profileKindEnum("inviter_profile_kind").notNull(),
    inviterProfileId: uuid("inviter_profile_id").notNull(),
    /** The role the *inviter* is taking — the recipient is bound to the opposite role on acceptance. */
    inviterRole: agreementPartyRoleEnum("inviter_role").notNull(),

    // Recipient identification (FR per this PRSprint's "Recipient Identification" section) — every
    // field nullable, since a sender may know only a name, only an email, only a phone, or already
    // know the recipient's platform identity.
    recipientName: text("recipient_name"),
    recipientEmail: text("recipient_email"),
    recipientPhone: text("recipient_phone"),
    /** Set once claimed (an existing user resolved at send time, or bound at acceptance). */
    recipientUserId: uuid("recipient_user_id").references(() => userAccount.id),
    recipientProfileKind: profileKindEnum("recipient_profile_kind"),
    recipientProfileId: uuid("recipient_profile_id"),

    /** Set only once `acceptPlan` creates the real, canonical agreement (Sprint 5's `AgreementService.createDraft`). */
    agreementId: uuid("agreement_id").references(() => agreement.id),

    currency: text("currency").notNull().default("USD"),
    frequency: paymentFrequencyEnum("frequency").notNull(),
    feeAllocation: feeAllocationEnum("fee_allocation").notNull(),
    /**
     * Mirrors `agreement_version.terms`'s own "required-field-set snapshot" JSONB pattern exactly —
     * same shape as `AgreementTerms` minus the two fields (`currentPrincipalMinorUnits`,
     * `finalPaymentMinorUnits`, `numberOfInstallments`) `computeSchedule` derives, so the anonymous
     * review page can compute an accurate live preview via the same pure function
     * `AgreementService` itself uses — no duplicated schedule math.
     */
    proposedTerms: jsonb("proposed_terms").notNull(),
    /** Optional sender message shown on the anonymous review page. */
    message: text("message"),
    /** "Current proposal version" (anonymous review display requirement) — incremented on every accepted Request-Changes/counter round before acceptance. */
    proposalVersion: integer("proposal_version").notNull().default(1),

    tokenHash: text("token_hash").notNull(),
    status: agreementInvitationStatusEnum("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("agreement_invitation_token_hash_unique").on(table.tokenHash)],
).enableRLS();
