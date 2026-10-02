import "server-only";
import type { AgreementService, AgreementWithDetail, CreateDraftInput } from "@/lib/agreements/agreementService";
import { ForbiddenError } from "@/lib/errors";
import { ORGANIZATION_AGREEMENTS_FEATURE_KEY } from "./entitlementFeatureKeys";
import type { EntitlementService } from "./entitlementService";
import type { OrganizationAuthorizationService } from "./organizationAuthorizationService";

export type AgreementWorkspaceSelector = { kind: "personal" } | { kind: "organization"; organizationId: string };

export interface CreateDraftForWorkspaceInput {
  userId: string;
  workspaceSelector: AgreementWorkspaceSelector;
  /**
   * Everything createDraft needs EXCEPT creatorUserId/organizationId — both of those are always
   * derived server-side by this method, never accepted from the caller's draftInput, so a public
   * request DTO handed through unchanged (after its own zod validation) cannot carry either field
   * even if it tried to.
   */
  draftInput: Omit<CreateDraftInput, "creatorUserId" | "organizationId">;
}

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 8 (2026-10-02): the
 * ONLY place `agreement.organizationId` is ever set to a non-null value. A thin orchestration layer
 * in front of the existing, deliberately-untouched `AgreementService.createDraft` — see that
 * method's own doc comment on `CreateDraftInput.organizationId` for why this split exists rather
 * than rewriting createDraft itself.
 *
 * Pipeline for `{ kind: "organization" }`:
 *   requested workspace -> authenticated user -> active membership -> capability
 *   ("manage_agreements") -> entitlement ("organization_agreements") -> server-assigned
 *   organizationId on the created agreement.
 *
 * Fail-closed, never fail-open: ANY missing membership, missing capability, or missing entitlement
 * throws ForbiddenError. This is deliberately NOT the same fallback behavior as
 * WorkspaceContextService.resolveWorkspaceContext (which quietly falls back to the personal
 * workspace for general navigation) — an explicit mutation request naming an organization must
 * never be silently downgraded into creating a personal agreement instead. A caller that actually
 * wants "use personal if the organization selection is invalid" must detect that itself and retry
 * with `{ kind: "personal" }`; this method never does it on the caller's behalf.
 */
export class AgreementWorkspaceService {
  constructor(
    private readonly agreements: AgreementService,
    private readonly orgAuth: OrganizationAuthorizationService,
    private readonly entitlements: EntitlementService,
  ) {}

  async createDraftForWorkspace(input: CreateDraftForWorkspaceInput): Promise<AgreementWithDetail> {
    if (input.workspaceSelector.kind === "personal") {
      // No membership check, no entitlement check — personal agreement creation is free and
      // requires no organization context at all, exactly as it already works today.
      return this.agreements.createDraft({ ...input.draftInput, creatorUserId: input.userId, organizationId: null });
    }

    const organizationId = input.workspaceSelector.organizationId;

    const membership = await this.orgAuth.resolveOrganizationMembership(input.userId, organizationId);
    if (!membership) {
      throw new ForbiddenError("You do not have an active membership in this organization workspace.");
    }

    const hasCapability = await this.orgAuth.can(input.userId, organizationId, "manage_agreements");
    if (!hasCapability) {
      throw new ForbiddenError("Your role does not permit creating agreements for this organization.");
    }

    const isEntitled = await this.entitlements.entitled(organizationId, ORGANIZATION_AGREEMENTS_FEATURE_KEY);
    if (!isEntitled) {
      throw new ForbiddenError("This organization's current plan does not include organization agreements.");
    }

    return this.agreements.createDraft({ ...input.draftInput, creatorUserId: input.userId, organizationId });
  }
}
