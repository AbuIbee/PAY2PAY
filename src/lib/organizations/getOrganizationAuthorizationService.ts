import "server-only";
import { DrizzleBusinessProfileRepository } from "@/lib/profiles/drizzleBusinessProfileRepository";
import { DrizzleBusinessStaffMemberRepository } from "@/lib/staff/drizzleBusinessStaffMemberRepository";
import { getStaffService } from "@/lib/staff/getStaffService";
import { OrganizationAuthorizationService } from "./organizationAuthorizationService";

let cached: OrganizationAuthorizationService | null = null;

export function getOrganizationAuthorizationService(): OrganizationAuthorizationService {
  if (!cached) {
    cached = new OrganizationAuthorizationService(
      new DrizzleBusinessProfileRepository(),
      new DrizzleBusinessStaffMemberRepository(),
      getStaffService(),
    );
  }
  return cached;
}
