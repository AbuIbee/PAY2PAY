import "server-only";
import { getOrganizationAuthorizationService } from "./getOrganizationAuthorizationService";
import { WorkspaceContextService } from "./workspaceContext";

let cached: WorkspaceContextService | null = null;

export function getWorkspaceContextService(): WorkspaceContextService {
  if (!cached) {
    cached = new WorkspaceContextService(getOrganizationAuthorizationService());
  }
  return cached;
}
