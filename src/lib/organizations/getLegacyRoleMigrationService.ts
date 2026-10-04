import "server-only";
import { DrizzleLegacyRoleMigrationRepository } from "./drizzleLegacyRoleMigrationRepository";
import { DrizzleOrganizationRoleRepository } from "./drizzleOrganizationRoleRepository";
import { LegacyRoleMigrationService } from "./legacyRoleMigration";

let cached: LegacyRoleMigrationService | null = null;

export function getLegacyRoleMigrationService(): LegacyRoleMigrationService {
  if (!cached) {
    cached = new LegacyRoleMigrationService(new DrizzleLegacyRoleMigrationRepository(), new DrizzleOrganizationRoleRepository());
  }
  return cached;
}
