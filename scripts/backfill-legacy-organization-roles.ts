/**
 * "Final RBAC Authorization Cutover", Step 6/32: the documented, scripted backfill path for any
 * PRE-EXISTING `business_staff_member`/`business_staff_invitation` row that predates this cutover and
 * still carries a null `role_id`.
 *
 * MUST be run against any database that may already contain such rows BEFORE applying the migration
 * that adds `business_staff_member_active_role_id_required` /
 * `business_staff_invitation_pending_role_id_required` (see
 * supabase/migrations/20261003040000_final_rbac_role_id_constraints.sql) — those CHECK constraints
 * will reject the migration outright if any qualifying row still has a null role_id, by design
 * (fail-closed, never silently defaulted).
 *
 * This repository is pre-launch/greenfield (see CLAUDE.md) — for a database created from scratch via
 * the full migration chain, this script is a guaranteed no-op: every mutation path
 * (`StaffService.inviteStaff`/`acceptInvitation`/`updateStaffRole`) resolves `role_id` explicitly at
 * write time (see staffService.ts), so no row can ever be created with a null value in the first
 * place. This script exists solely for data that predates that mutation-time fix.
 *
 * Deliberately reuses `LegacyRoleMigrationService.migrateAllOrganizations()` — the SAME canonical,
 * already-tested translation logic (src/lib/organizations/legacyRoleMigration.ts) runtime
 * authorization itself depends on — rather than re-deriving the permission-translation table in raw
 * SQL, which would risk silently drifting from the one true source. Deterministic, tenant-scoped (one
 * organization at a time), and idempotent (safe to run more than once; a second run backfills zero
 * additional rows).
 *
 * Requires the same environment configuration as the running application (at minimum DATABASE_URL,
 * AUDIT_HASH_SECRET, AUTH_PASSWORD_PEPPER). Requires the `react-server` module-resolution condition —
 * Next.js's own bundler applies this implicitly to route the `server-only` marker package to its
 * no-op build; a plain Node/tsx invocation must request it explicitly.
 *
 * Run with: `npm run db:backfill-legacy-roles` (see package.json), or directly:
 *   npx tsx --conditions=react-server scripts/backfill-legacy-organization-roles.ts
 */
import { getLegacyRoleMigrationService } from "@/lib/organizations/getLegacyRoleMigrationService";

async function main() {
  const result = await getLegacyRoleMigrationService().migrateAllOrganizations();
  console.log(
    `[backfill-legacy-organization-roles] organizations processed: ${result.organizationsProcessed}, ` +
      `memberships backfilled: ${result.membershipsBackfilled}, invitations backfilled: ${result.invitationsBackfilled}`,
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("[backfill-legacy-organization-roles] failed:", error);
  process.exit(1);
});
