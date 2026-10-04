import "server-only";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { AgreementWorkspaceService } from "./agreementWorkspaceService";
import { getEntitlementService } from "./getEntitlementService";
import { getOrganizationPermissionService } from "./getOrganizationPermissionService";

let cached: AgreementWorkspaceService | null = null;

export function getAgreementWorkspaceService(): AgreementWorkspaceService {
  if (!cached) {
    cached = new AgreementWorkspaceService(getAgreementService(), getOrganizationPermissionService(), getEntitlementService());
  }
  return cached;
}
