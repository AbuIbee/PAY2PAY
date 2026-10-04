-- "PAID2YOU PLATFORM EXPANSION" (2026-10-03), Final RBAC Authorization Cutover, Step 6/32: a null
-- role_id must be an EXCEPTION, enforced by the database, never a silently-tolerated steady state for
-- any row OrganizationPermissionService could still be asked to authorize.
--
-- IMPORTANT — operational prerequisite: if this migration is ever applied against a database that may
-- already contain `business_staff_member` (not removed) or `business_staff_invitation` (`pending`)
-- rows with a null `role_id`, run the idempotent backfill FIRST:
--   npm run db:backfill-legacy-roles
-- (see scripts/backfill-legacy-organization-roles.ts). This repository is pre-launch/greenfield (see
-- CLAUDE.md) and every application mutation path that creates such a row
-- (StaffService.inviteStaff/acceptInvitation/updateStaffRole) already resolves role_id explicitly at
-- write time, so for a database built from scratch via this migration chain the backfill is a
-- guaranteed no-op and this migration will apply cleanly with no pre-step required.
ALTER TABLE "business_staff_member" ADD CONSTRAINT "business_staff_member_active_role_id_required" CHECK ("removed_at" IS NOT NULL OR "role_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "business_staff_invitation" ADD CONSTRAINT "business_staff_invitation_pending_role_id_required" CHECK ("status" != 'pending' OR "role_id" IS NOT NULL);
