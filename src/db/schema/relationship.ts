import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businessProfile, personalProfile, userAccount } from "./identity";
import {
  agreementPartyRoleEnum,
  relationshipInvitationStatusEnum,
  relationshipParticipantStatusEnum,
  relationshipStatusEnum,
} from "./enums";

/**
 * Sprint 18A (docs/sprints/Sprint_18A_CooperativeAccountPairing_FinancialAccountLinking_
 * RelationshipArchitecture.md): the canonical, first-class payment relationship — "REL" in that
 * spec's own conceptual notation (no literal `REL_` id prefix is introduced; this codebase has never
 * prefixed a uuid primary key, and "do not rename mature IDs merely to match this prefix" extends by
 * the same logic to not inventing a new prefixing convention nowhere else in the schema uses).
 *
 * `context` is free text (default `"repayment_agreement"`, the only context this codebase's master
 * spec currently defines) rather than an enum — mirrors `notification_type`'s identical Sprint 13
 * precedent (enums.ts's own doc comment) for a vocabulary this sprint is deliberately not closing off.
 *
 * A relationship's own `status` intentionally never represents "disputed" — see enums.ts's
 * `relationshipStatusEnum` doc comment for why dispute state is read from Sprint 16's
 * `agreement_dispute`/`payment_dispute` rather than duplicated here.
 */
export const relationship = pgTable("relationship", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  status: relationshipStatusEnum("status").notNull().default("invited"),
  context: text("context").notNull().default("repayment_agreement"),
  initiatorUserId: uuid("initiator_user_id")
    .notNull()
    .references(() => userAccount.id),
  // Cached forward-pointer to the agreement currently governing this relationship — mirrors
  // agreement.ts's own currentVersionId precedent exactly (not FK-constrained: agreement.ts already
  // imports this file for its own relationshipId FK, so a real FK in the other direction would be a
  // circular schema-file import; application code — RelationshipService.linkAgreement — is the sole
  // writer and always keeps this in sync, same guarantee currentVersionId already relies on).
  currentAgreementId: uuid("current_agreement_id"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  restrictedAt: timestamp("restricted_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * Sprint 18A: a relationship's principal counterparty — exactly one of `individual_profile_id` /
 * `organization_id` is set (enforced by the CHECK constraint below, hand-verified present in the
 * generated migration — drizzle-kit's CHECK-constraint generation is newer/less consistently reliable
 * than its column/FK generation, so the migration is checked by hand, not just trusted). This is a
 * deliberately *stronger* pattern than the `profileKind + profileId` pair every prior sprint's tables
 * use (no real FK possible there, by design, per those tables' own doc comments) — Sprint 18A's spec
 * explicitly prefers "strong relational integrity" with "database CHECK constraints" for new tables,
 * and reusing the weaker existing pattern here would forgo real referential integrity for no reason
 * on a brand-new table.
 *
 * `role` reuses `agreementPartyRoleEnum` (creditor/debtor) directly rather than inventing competing
 * obligor/obligee/payer/receiver terminology — this sprint's own instruction: "reuse existing
 * debtor/creditor terminology where already authoritative... do not create duplicate competing
 * semantics."
 */
export const relationshipParticipant = pgTable(
  "relationship_participant",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    relationshipId: uuid("relationship_id")
      .notNull()
      .references(() => relationship.id),
    individualProfileId: uuid("individual_profile_id").references(() => personalProfile.id),
    organizationId: uuid("organization_id").references(() => businessProfile.id),
    role: agreementPartyRoleEnum("role").notNull(),
    status: relationshipParticipantStatusEnum("status").notNull().default("invited"),
    // The user acting for this participant — always set (even for an individual participant, this is
    // that profile's own owning user; for an organization participant, the specific authorized staff
    // member/owner who linked this participation, per this sprint's "represented_by_user_id where
    // relevant").
    representedByUserId: uuid("represented_by_user_id").references(() => userAccount.id),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "relationship_participant_exactly_one_party",
      sql`(${table.individualProfileId} IS NOT NULL AND ${table.organizationId} IS NULL) OR (${table.individualProfileId} IS NULL AND ${table.organizationId} IS NOT NULL)`,
    ),
    // For today's two-principal repayment model: one participant per role per relationship. A future
    // sprint supporting >2 principals (not required by the current master spec) would need to revisit
    // this index, not just the application-layer check.
    uniqueIndex("relationship_participant_relationship_role_unique").on(table.relationshipId, table.role),
  ],
).enableRLS();

/**
 * Sprint 18A §6/§7/§8's cooperative handshake. `token_hash` is the only persisted representation of
 * the invitation secret — mirrors `password_reset_token`/`email_verification_token`'s identical
 * Sprint 2 `generateOpaqueToken`/`hashOpaqueToken` pattern exactly (`src/lib/auth/token.ts`), reused
 * rather than inventing a second token scheme.
 *
 * `invitee_role` is the role *offered to the invitee* — the inviter's own role is already recorded on
 * their own `relationship_participant` row created at invite time, so it is never duplicated here.
 */
export const relationshipInvitation = pgTable("relationship_invitation", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  relationshipId: uuid("relationship_id")
    .notNull()
    .references(() => relationship.id),
  inviterUserId: uuid("inviter_user_id")
    .notNull()
    .references(() => userAccount.id),
  inviteeEmail: text("invitee_email").notNull(),
  inviteeRole: agreementPartyRoleEnum("invitee_role").notNull(),
  status: relationshipInvitationStatusEnum("status").notNull().default("sent"),
  tokenHash: text("token_hash").notNull(),
  resolvedInviteeUserId: uuid("resolved_invitee_user_id").references(() => userAccount.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  viewedAt: timestamp("viewed_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  declinedAt: timestamp("declined_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
