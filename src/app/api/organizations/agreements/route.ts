import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementProgressService } from "@/lib/agreements/agreementProgressService";
import type { AgreementService } from "@/lib/agreements/agreementService";
import { getAgreementProgressService } from "@/lib/agreements/getAgreementProgressService";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";
import { parsePageParams, toPage } from "@/lib/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listQuerySchema = z.object({ organizationId: z.string().uuid() });

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Final RBAC Authorization Cutover, Step 10: organization
 * agreement READ access. Requires BOTH an active organization membership AND the stable
 * `agreements.view` permission through the canonical `OrganizationPermissionService` — membership
 * existence alone is no longer sufficient. `AgreementService.listAgreements` (Phase 9, unchanged) is
 * still called underneath and still independently requires the caller be authorized for the
 * organization PARTY (`requireActiveStaff`, since no capability is passed for a plain read) — that
 * PARTY-level check and this ORGANIZATION-level `agreements.view` check are deliberately two
 * independent gates (Step 9), neither substitutes for the other. Replaces the prior phase's direct
 * `GET /api/agreements?profileKind=business` call from `OrganizationAgreements.tsx`, which relied on
 * the PARTY-level gate alone.
 */
export function createOrganizationAgreementsGetHandler(authService: AuthService, permissions: OrganizationPermissionService, agreementService: AgreementService, progressService: AgreementProgressService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const url = new URL(request.url);
    const parsed = listQuerySchema.safeParse({ organizationId: url.searchParams.get("organizationId") });
    if (!parsed.success) throw new ValidationError("A valid organizationId is required.");

    await permissions.require(userId, parsed.data.organizationId, "agreements.view");

    const pageParams = parsePageParams(url.searchParams);
    const agreements = await agreementService.listAgreements(userId, { kind: "business", id: parsed.data.organizationId }, { limit: pageParams.limit + 1, offset: pageParams.offset });
    const page = toPage(agreements, pageParams);
    const attention = await Promise.all(
      page.items.map((a) =>
        progressService
          .getProgress(a.id, userId)
          .then((p) => p.primaryAction.label)
          .catch(() => null),
      ),
    );
    return NextResponse.json(
      {
        agreements: page.items.map((a, index) => ({
          id: a.id,
          status: a.status,
          currency: a.currency,
          relationshipShape: agreementService.relationshipShape(a),
          createdAt: a.createdAt,
          attentionLabel: attention[index] ?? null,
        })),
        limit: page.limit,
        offset: page.offset,
        hasMore: page.hasMore,
      },
      { status: 200 },
    );
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createOrganizationAgreementsGetHandler(getAuthService(), getOrganizationPermissionService(), getAgreementService(), getAgreementProgressService())(request);
}

export const GET = withErrorHandling("organizations_agreements_get", handleGet);
