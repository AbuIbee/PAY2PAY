import "server-only";
import { DrizzleBusinessStaffMemberRepository } from "@/lib/staff/drizzleBusinessStaffMemberRepository";
import { DrizzleOrganizationRoleRepository } from "./drizzleOrganizationRoleRepository";
import { DrizzleBusinessProfileRepository } from "@/lib/profiles/drizzleBusinessProfileRepository";
import { OrganizationPermissionService } from "./organizationPermissionService";

let cached: OrganizationPermissionService | null = null;

export function getOrganizationPermissionService(): OrganizationPermissionService {
  if (!cached) {
    cached = new OrganizationPermissionService(new DrizzleBusinessProfileRepository(), new DrizzleBusinessStaffMemberRepository(), new DrizzleOrganizationRoleRepository());
  }
  return cached;
}
