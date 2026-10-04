import "server-only";
import { DrizzleBusinessStaffMemberRepository } from "@/lib/staff/drizzleBusinessStaffMemberRepository";
import { DrizzleBusinessProfileRepository } from "@/lib/profiles/drizzleBusinessProfileRepository";
import { getOrganizationAuthorizationService } from "./getOrganizationAuthorizationService";
import { WorkspaceContextService } from "./workspaceContext";

let cached: WorkspaceContextService | null = null;

export function getWorkspaceContextService(): WorkspaceContextService {
  if (!cached) {
    cached = new WorkspaceContextService(getOrganizationAuthorizationService(), new DrizzleBusinessStaffMemberRepository(), new DrizzleBusinessProfileRepository());
  }
  return cached;
}
