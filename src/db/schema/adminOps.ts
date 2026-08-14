import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { userAccount } from "./identity";
import {
  adminRestrictionTypeEnum,
  appealDecisionEnum,
  appealStatusEnum,
  internalAdminRoleEnum,
  retentionHoldTypeEnum,
  supportCaseStatusEnum,
} from "./enums";

/**
 * Sprint 18 (docs/sprints/SPRINT_18_AdminSupport_Appeals.md): internal admin-role assignment,
 * retention/legal holds, platform/agreement-level administrative restrictions (distinct from Sprint
 * 18A's relationship-scoped `RelationshipService.restrict` — see relationshipRestriction's own doc
 * comment below), support cases, and appeals.
 *
 * `target_resource_type` columns are free text throughout, not closed enums — mirrors
 * `audit_event.target_resource_type`/`relationship.context`'s identical established precedent for a
 * vocabulary this sprint does not need to close off (a hold or restriction may reasonably target a
 * `user_account`, `business_profile`, `agreement`, `payment_attempt`, or a future resource type this
 * sprint doesn't need to enumerate up front).
 */
export const adminRoleAssignment = pgTable(
  "admin_role_assignment",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => userAccount.id),
    role: internalAdminRoleEnum("role").notNull(),
    assignedByUserId: uuid("assigned_by_user_id")
      .notNull()
      .references(() => userAccount.id),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    // Non-destructive removal (mirrors business_staff_member.removedAt exactly) — NULL = active.
    revokedByUserId: uuid("revoked_by_user_id").references(() => userAccount.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    // At most one *active* internal role per user — re-assigning first requires revoking the prior one, preserving full history.
    uniqueIndex("admin_role_assignment_active_user_unique").on(table.userId).where(sql`${table.revokedAt} IS NULL`),
  ],
).enableRLS();

/**
 * "A hold of any type blocks scheduled deletion/minimization of the affected records until every
 * applicable hold on those records is explicitly released" (this sprint's own instruction, verbatim).
 * `RetentionHoldService.hasActiveHold` is the query a future deletion/minimization job (none exists
 * yet anywhere in this codebase — see that service's own doc comment) must consult before purging
 * anything. Never deleted, never overwritten — release only ever sets `released_at`/`released_by_user_id`
 * on the existing row, preserving the full hold history the same way every other append-only table in
 * this codebase does.
 */
export const retentionHold = pgTable("retention_hold", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  targetResourceType: text("target_resource_type").notNull(),
  targetResourceId: uuid("target_resource_id").notNull(),
  holdType: retentionHoldTypeEnum("hold_type").notNull(),
  reason: text("reason").notNull(),
  placedByUserId: uuid("placed_by_user_id")
    .notNull()
    .references(() => userAccount.id),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
  releasedByUserId: uuid("released_by_user_id").references(() => userAccount.id),
  releasedAt: timestamp("released_at", { withTimezone: true }),
}).enableRLS();

/**
 * Platform/agreement-level administrative restriction — deliberately excludes account suspension
 * (Sprint 6A's `AdminService.suspendUser`/`reactivateUser` already own that behavior unchanged) and
 * is entirely separate from Sprint 18A's `relationship_participant`-scoped
 * `RelationshipService.restrict` (a narrower, relationship-specific control) and from Sprint 16's
 * dispute-scoped `agreement_dispute.status = 'restricted'` (only meaningful within one dispute's own
 * lifecycle). This table is the general-purpose, admin-initiated restriction an internal reviewer may
 * place independent of any specific dispute or relationship — see adminRestrictionService.ts's own
 * doc comment for the full boundary rationale.
 */
export const adminRestriction = pgTable(
  "admin_restriction",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    restrictionType: adminRestrictionTypeEnum("restriction_type").notNull(),
    targetResourceType: text("target_resource_type").notNull(),
    targetResourceId: uuid("target_resource_id").notNull(),
    reason: text("reason").notNull(),
    // Links this restriction to the appeal/support case that may contest it — free text, not an FK,
    // since a restriction may be placed before any case exists yet.
    caseReference: text("case_reference"),
    placedByUserId: uuid("placed_by_user_id")
      .notNull()
      .references(() => userAccount.id),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    liftedByUserId: uuid("lifted_by_user_id").references(() => userAccount.id),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
  },
  (table) => [
    // At most one *active* restriction of a given type per target — re-restricting first requires lifting the prior one.
    uniqueIndex("admin_restriction_active_target_unique")
      .on(table.targetResourceType, table.targetResourceId, table.restrictionType)
      .where(sql`${table.liftedAt} IS NULL`),
  ],
).enableRLS();

/** Sprint 18 §29 "Manage support cases." Deliberately minimal — open/update-status/close, no ticketing-system features (SLAs, categories taxonomy, assignment queues) this sprint's own file never names. */
export const supportCase = pgTable("support_case", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  subjectUserId: uuid("subject_user_id")
    .notNull()
    .references(() => userAccount.id),
  // Nullable: reserved for a future user-initiated support flow (Sprint 18's own file scopes this
  // sprint to admin-managed cases only — every case in this pass is opened by an admin).
  openedByUserId: uuid("opened_by_user_id").references(() => userAccount.id),
  category: text("category"),
  summary: text("summary").notNull(),
  status: supportCaseStatusEnum("status").notNull().default("open"),
  resolutionNotes: text("resolution_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}).enableRLS();

/**
 * Sprint 18 §30 Appeals. "Prevent the original decision-maker from being the sole appeal reviewer"
 * (this sprint's own instruction, verbatim) is enforced at two layers: the CHECK constraint below
 * (database-level, cannot be bypassed by any future caller of this table) and
 * `AppealService.assignReviewer`'s own application-level check (see that method's doc comment for why
 * both layers exist). "Restrictions stay in place during review unless an authorized reviewer lifts
 * them" is enforced by construction: nothing on this table itself can lift a restriction — only
 * `AppealService.decideAppeal`'s own explicit call into `AdminRestrictionService.lift` can, and only
 * for a `decided` appeal.
 */
export const appeal = pgTable(
  "appeal",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    appealingUserId: uuid("appealing_user_id")
      .notNull()
      .references(() => userAccount.id),
    targetResourceType: text("target_resource_type").notNull(),
    targetResourceId: uuid("target_resource_id").notNull(),
    originalDecisionSummary: text("original_decision_summary").notNull(),
    // Nullable — some restrictions are system/dispute-driven (Sprint 16) rather than placed by a
    // specific admin user; "the original decision-maker must not be the sole reviewer" has nothing to
    // enforce against when there was no individual human decision-maker in the first place.
    originalDecisionByUserId: uuid("original_decision_by_user_id").references(() => userAccount.id),
    evidenceDescription: text("evidence_description"),
    status: appealStatusEnum("status").notNull().default("submitted"),
    reviewerUserId: uuid("reviewer_user_id").references(() => userAccount.id),
    decision: appealDecisionEnum("decision"),
    rationale: text("rationale"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "appeal_reviewer_not_original_decision_maker",
      sql`${table.reviewerUserId} IS NULL OR ${table.originalDecisionByUserId} IS NULL OR ${table.reviewerUserId} <> ${table.originalDecisionByUserId}`,
    ),
  ],
).enableRLS();
