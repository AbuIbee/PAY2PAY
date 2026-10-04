import { sql } from "drizzle-orm";
import { boolean, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businessProfile } from "./identity";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), DB-3: organization-owned custom roles — replaces the
 * hardcoded `organizationRoleEnum` (OWNER/FINANCE_ADMIN/AR_MANAGER/AR_AGENT/VIEWER) as the long-term
 * role-name authorization model (Requirement 8). Deliberately a NEW table, not a rename of the
 * pre-existing `custom_role` (src/db/schema/identity.ts) — that table is the Sprint-4-era precursor
 * for the explicitly DEFERRED arbitrary-custom-role feature (see capabilities.ts's own doc comment:
 * "custom roles deferred... customRoleId is never consulted for authorization"); it has zero live
 * rows and zero current authorization dependency, and renaming it would risk the unaudited
 * OrganizationStaffRoles.tsx/drizzleCustomRoleRepository.ts call sites for no safety benefit. This
 * table is the one authorization actually migrates onto (see legacyRoleMigration.ts for how
 * existing organizationRoleEnum-based memberships become rows here, additively, without yet
 * cutting over authorization itself — see that file's own doc comment for why the cutover is a
 * separate, later step).
 *
 * `isOwnerRole`/`isProtected` are independent flags: every organization's seeded "Owner" role has
 * both set true (Requirement 9's protected-ownership invariant — the role itself can never be
 * deleted, and exactly which role IS the owner role is never inferred from its current permission
 * set, so an ordinary role selecting every checkbox still never becomes the owner role). A future
 * organization could in principle mark another role `isProtected` without it being the owner role
 * (reserved for that case); this phase only ever sets both together, on the one seeded Owner role.
 */
export const organizationRole = pgTable(
  "organization_role",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => businessProfile.id),
    displayName: text("display_name").notNull(),
    description: text("description"),
    isOwnerRole: boolean("is_owner_role").notNull().default(false),
    isProtected: boolean("is_protected").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Requirement 10/12 explicitly allow duplicate role names ACROSS different organizations — this
    // only guards against the same organization creating two roles with the identical display name.
    uniqueIndex("organization_role_org_name_unique").on(table.organizationId, table.displayName),
    // At most one owner role per organization — Requirement 9's "the final Owner cannot be replaced
    // by ordinary permission assignment" starts with there only ever being one canonical owner role
    // to begin with.
    uniqueIndex("organization_role_org_owner_unique").on(table.organizationId).where(sql`${table.isOwnerRole} = true`),
  ],
).enableRLS();

/**
 * Requirement 13: resource scope. Only "organization" is actually backed by any implemented
 * authorization check today (see organizationAuthorizationService.ts) — "assigned"/"own"/"team" are
 * accepted here as a forward-compatible vocabulary (so a role's stored scope choice never needs a
 * schema migration when a narrower scope becomes real) but are NOT YET enforced by any service;
 * permissionCatalog.ts's own `supportedScopes` per permission is what a role EDITOR must consult
 * before ever offering one of these as a live choice — never inferred from this enum alone.
 */
export const organizationRolePermissionScopeEnum = pgEnum("organization_role_permission_scope", [
  "organization",
  "assigned",
  "own",
  "team",
  "none",
]);

/**
 * One row per (role, permission) — the normalized replacement for the pre-existing `custom_role.
 * permissions` JSONB blob, needed specifically because Requirement 13 requires a per-permission
 * SCOPE, which a bare JSONB array of permission strings cannot represent without inventing an
 * ad hoc nested shape this table expresses directly and queryably instead. `permissionKey` is
 * intentionally a plain `text` column, not a DB enum — the stable permission vocabulary
 * (permissionCatalog.ts) is expected to grow over time, and a new permission key must never require
 * a schema migration; `isPermissionKey()` (permissionCatalog.ts) is the single source of truth for
 * validating a key at write time, enforced in the service layer, not the database.
 */
export const organizationRolePermission = pgTable(
  "organization_role_permission",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    roleId: uuid("role_id")
      .notNull()
      .references(() => organizationRole.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull(),
    scope: organizationRolePermissionScopeEnum("scope").notNull().default("organization"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("organization_role_permission_role_key_unique").on(table.roleId, table.permissionKey)],
).enableRLS();
