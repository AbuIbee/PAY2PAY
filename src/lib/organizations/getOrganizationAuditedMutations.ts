import "server-only";
import type { OrganizationAuditedMutations } from "./organizationAuditedMutations";
import { DrizzleOrganizationAuditedMutations } from "./organizationAuditedMutationsDrizzle";

let cached: OrganizationAuditedMutations | null = null;

export function getOrganizationAuditedMutations(): OrganizationAuditedMutations {
  if (!cached) {
    cached = new DrizzleOrganizationAuditedMutations();
  }
  return cached;
}
