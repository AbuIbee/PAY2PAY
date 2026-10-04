import "server-only";
import { DrizzleOrganizationRoleRepository } from "./drizzleOrganizationRoleRepository";
import { OrganizationRoleService } from "./organizationRoleService";

let cached: OrganizationRoleService | null = null;

export function getOrganizationRoleService(): OrganizationRoleService {
  if (!cached) {
    cached = new OrganizationRoleService(new DrizzleOrganizationRoleRepository());
  }
  return cached;
}
