import type { PlatformRole } from "@/lib/auth/authService";

/**
 * Sprint 6A (docs/sprints/SPRINT_06A_Platform_Administration_Audit_Control.md) platform-role
 * hierarchy — entirely separate from Sprint 4's business-staff `capabilities.ts` (an agreement
 * party's rights within one business) and from `agreement_party_role` (creditor/debtor within one
 * agreement). Never role-name-compares directly outside this module, matching Sprint 4's own "Do
 * not use role names alone as authorization" precedent.
 */
const PLATFORM_ROLE_RANK: Record<PlatformRole, number> = {
  member: 0,
  platform_admin: 1,
  platform_owner: 2,
};

export function hasAtLeastPlatformRole(role: PlatformRole, minimum: PlatformRole): boolean {
  return PLATFORM_ROLE_RANK[role] >= PLATFORM_ROLE_RANK[minimum];
}

export function isAdminRole(role: PlatformRole): boolean {
  return hasAtLeastPlatformRole(role, "platform_admin");
}

export function isOwnerRole(role: PlatformRole): boolean {
  return role === "platform_owner";
}
