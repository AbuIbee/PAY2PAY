import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { approvalRequestStatusEnum, organizationRoleEnum, staffInvitationStatusEnum } from "./enums";
import { businessProfile, businessStaffMember, customRole, userAccount } from "./identity";
import { organizationRole } from "./organizationRoles";

/**
 * Sprint 4 (docs/sprints/SPRINT_04_BusinessStaff_Permissions.md) staff
 * invitation, approval-limit, and approval-request architecture.
 * `business_staff_member`/`custom_role` already exist from Phase 0
 * (src/db/schema/identity.ts) — this file adds only what Sprint 4 requires
 * on top of them.
 */

/**
 * Not the same as docs/DATA_MODEL.md §4's `invitation` table — that one is
 * scoped to agreement counterparties (debtor/creditor/witness) and requires
 * an agreement_id. Staff invitations have no agreement, so they get their
 * own table, following the same token-hash pattern (never store the raw
 * invitation token, only its hash — see device_session.sessionTokenHash).
 */
export const businessStaffInvitation = pgTable(
  "business_staff_invitation",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    businessProfileId: uuid("business_profile_id")
      .notNull()
      .references(() => businessProfile.id),
    // Normalization (lowercasing) is the caller's responsibility, matching
    // user_account.email's convention (see identity.ts's doc comment).
    email: text("email").notNull(),
    role: organizationRoleEnum("role").notNull(), // OWNER | FINANCE_ADMIN | AR_MANAGER | AR_AGENT | VIEWER
    customRoleId: uuid("custom_role_id").references(() => customRole.id),
    // "PAID2YOU PLATFORM EXPANSION" (2026-10-02), corrected by the Final RBAC Authorization Cutover:
    // see `business_staff_member.roleId`'s own doc comment in identity.ts — identical purpose/status
    // here. `StaffService.inviteStaff` now resolves this up front for every new invitation; a null
    // value is an exception only for invitations issued before that change, enforced for `pending`
    // rows (the only status acceptance ever reads `roleId` from) by the CHECK constraint below.
    roleId: uuid("role_id").references(() => organizationRole.id),
    invitedByUserId: uuid("invited_by_user_id")
      .notNull()
      .references(() => userAccount.id),
    tokenHash: text("token_hash").notNull().unique(),
    status: staffInvitationStatusEnum("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => userAccount.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("business_staff_invitation_business_email_pending_unique")
      .on(table.businessProfileId, table.email)
      .where(sql`${table.status} = 'pending'`),
    // "Final RBAC Authorization Cutover", Step 6/32: the analogous exception-not-steady-state rule
    // for invitations — only a still-`pending` row can ever be accepted (and have its role_id copied
    // onto the resulting membership), so only `pending` rows are required to carry one.
    check("business_staff_invitation_pending_role_id_required", sql`${table.status} != 'pending' OR ${table.roleId} IS NOT NULL`),
  ],
).enableRLS();

/**
 * Settlement/balance-adjustment approval limits, two-person approval
 * configuration, and owner-required thresholds — all Sprint 4 requirements
 * — expressed as one policy row per (business, capability). A capability
 * with no policy row here has no threshold gate (StaffService/
 * ApprovalService fall back to plain capability-possession).
 */
export const businessApprovalPolicy = pgTable(
  "business_approval_policy",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    businessProfileId: uuid("business_profile_id")
      .notNull()
      .references(() => businessProfile.id),
    capability: text("capability").notNull(), // e.g. approve_settlement, approve_partial_payment, forgive_principal
    // Minor units (never float — master spec §37 / FR-MONEY-001). NULL means
    // the policy applies regardless of amount.
    thresholdMinorUnits: integer("threshold_minor_units"),
    requiresDualApproval: boolean("requires_dual_approval").notNull().default(false),
    requiresOwner: boolean("requires_owner").notNull().default(false),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => userAccount.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("business_approval_policy_business_capability_unique").on(
      table.businessProfileId,
      table.capability,
    ),
  ],
).enableRLS();

/**
 * Matches docs/DATA_MODEL.md §4's illustrative `staff_approval_request`
 * schema exactly, including the no-self-approval CHECK constraint.
 * `related_agreement_id` has no FK yet — the `agreement` table doesn't exist
 * until Sprint 5 (docs/IMPLEMENTATION_PLAN.md); it's a plain uuid column
 * here and the FK will be added when that table lands.
 */
export const staffApprovalRequest = pgTable(
  "staff_approval_request",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    businessProfileId: uuid("business_profile_id")
      .notNull()
      .references(() => businessProfile.id),
    proposedByStaffId: uuid("proposed_by_staff_id")
      .notNull()
      .references(() => businessStaffMember.id),
    relatedAgreementId: uuid("related_agreement_id"), // agreement(id) — FK added in Sprint 5
    actionType: text("action_type").notNull(),
    actionPayload: jsonb("action_payload").notNull(),
    reasonFlagged: text("reason_flagged").notNull(), // which policy triggered this request (threshold / dual-approval / owner-required)
    status: approvalRequestStatusEnum("status").notNull().default("pending"),
    approvedByStaffId: uuid("approved_by_staff_id").references(() => businessStaffMember.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "staff_approval_request_no_self_approval",
      sql`${table.approvedByStaffId} IS NULL OR ${table.approvedByStaffId} <> ${table.proposedByStaffId}`,
    ),
  ],
).enableRLS();
