import "server-only";
import type { AgreementRecord, AgreementService, AgreementWithDetail, CreateDraftInput } from "@/lib/agreements/agreementService";
import { ForbiddenError } from "@/lib/errors";
import { ORGANIZATION_AGREEMENTS_FEATURE_KEY } from "./entitlementFeatureKeys";
import type { EntitlementService } from "./entitlementService";
import type { OrganizationPermissionService } from "./organizationPermissionService";

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
 *   requested workspace -> authenticated user -> active membership -> stable permission
 *   ("agreements.create", via the canonical OrganizationPermissionService) -> entitlement
 *   ("organization_agreements") -> server-assigned organizationId on the created agreement.
 *
 * "Final RBAC Authorization Cutover" (2026-10-02): completes the cutover a prior pass deliberately
 * deferred. The blocker was a translation-table imprecision, not an architectural one —
 * `LEGACY_CAPABILITY_TO_PERMISSION_KEYS` used to collapse the PARTY-level `create_agreement` capability
 * onto `agreements.create`, which would have silently re-granted AR_AGENT (who held `create_agreement`
 * but never `manage_agreements`) organization agreement creation — exactly the access Phase 8
 * deliberately denies it. Fixed at the source (legacyRoleMigration.ts: `create_agreement` now maps to
 * nothing; `manage_agreements` is the sole legacy source of `agreements.create`/`agreements.edit`/
 * `agreements.send`/`agreements.cancel`/`agreements.export`), not by inventing a parallel check here.
 * `manage_agreements`/`OrganizationAuthorizationService` is no longer consulted by this method at all.
 *
 * Fail-closed, never fail-open: ANY missing membership, missing permission, or missing entitlement
 * throws ForbiddenError. This is deliberately NOT the same fallback behavior as
 * WorkspaceContextService.resolveWorkspaceContext (which quietly falls back to the personal
 * workspace for general navigation) — an explicit mutation request naming an organization must
 * never be silently downgraded into creating a personal agreement instead. A caller that actually
 * wants "use personal if the organization selection is invalid" must detect that itself and retry
 * with `{ kind: "personal" }`; this method never does it on the caller's behalf.
 *
 * Phase 9 audit (dual authorization layers — ORGANIZATION `agreements.create` vs. PARTY
 * `create_agreement`): calling `createDraft` here does NOT bypass `AgreementService`'s own,
 * pre-existing `tryAuthorizeParty` check — that check still independently requires the actor to be
 * authorized for the creditor OR debtor PARTY (personal profile ownership, or the legacy
 * `create_agreement` capability as a business staff member of whichever party is a business profile).
 * This is intentional, not a bug: `agreements.create` answers "may this staff member tag an agreement
 * as belonging to THIS ORGANIZATION WORKSPACE"; `create_agreement` answers "may this actor act for the
 * creditor/debtor PARTY" — different questions, deliberately never collapsed into one (see Step 9's own
 * "Party and Organization authorization must remain separate" requirement). They compose without
 * conflict in the realistic/intended shape for this phase: an organization-scoped agreement where the
 * organization's own `business_profile` is the creditor or debtor party, created by one of ITS OWN
 * staff — FINANCE_ADMIN/AR_MANAGER/OWNER hold both capabilities by default (capabilities.ts), so both
 * layers pass together for the same membership, with no double-grant invented here. An organization
 * tagging an agreement between two UNRELATED personal parties it is not itself a party to is a
 * different, broader feature this phase does not implement or test — not a conflict to resolve, simply
 * out of scope (the party-authorization model is deliberately left untouched).
 */
export class AgreementWorkspaceService {
  constructor(
    private readonly agreements: AgreementService,
    private readonly permissions: OrganizationPermissionService,
    private readonly entitlements: EntitlementService,
  ) {}

  /** Pure display computation, delegated unchanged — never an authorization decision. */
  relationshipShape(agreement: Pick<AgreementRecord, "creditorProfileKind" | "debtorProfileKind">): "P2P" | "B2C" | "C2B" | "B2B" {
    return this.agreements.relationshipShape(agreement);
  }

  async createDraftForWorkspace(input: CreateDraftForWorkspaceInput): Promise<AgreementWithDetail> {
    if (input.workspaceSelector.kind === "personal") {
      // No membership check, no entitlement check — personal agreement creation is free and
      // requires no organization context at all, exactly as it already works today.
      return this.agreements.createDraft({ ...input.draftInput, creatorUserId: input.userId, organizationId: null });
    }

    const organizationId = input.workspaceSelector.organizationId;

    const membership = await this.permissions.resolveActiveMembership(input.userId, organizationId);
    if (!membership) {
      throw new ForbiddenError("You do not have an active membership in this organization workspace.");
    }

    const hasPermission = await this.permissions.membershipCan(membership, "agreements.create");
    if (!hasPermission) {
      throw new ForbiddenError("Your role does not permit creating agreements for this organization.");
    }

    const isEntitled = await this.entitlements.entitled(organizationId, ORGANIZATION_AGREEMENTS_FEATURE_KEY);
    if (!isEntitled) {
      throw new ForbiddenError("This organization's current plan does not include organization agreements.");
    }

    return this.agreements.createDraft({ ...input.draftInput, creatorUserId: input.userId, organizationId });
  }
}
