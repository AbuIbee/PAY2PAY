import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementService } from "@/lib/agreements/agreementService";
import type { AgreementProgressService } from "@/lib/agreements/agreementProgressService";
import { createAgreementSchema } from "@/lib/agreements/validation";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { getAgreementProgressService } from "@/lib/agreements/getAgreementProgressService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { parsePageParams, toPage } from "@/lib/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createAgreementCreateHandler(authService: AuthService, agreementService: AgreementService) {
  return async function handleCreate(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = createAgreementSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid agreement draft is required.");
    }

    const result = await agreementService.createDraft({ creatorUserId: userId, ...parsed.data });
    return NextResponse.json(
      {
        id: result.agreement.id,
        status: result.agreement.status,
        relationshipShape: agreementService.relationshipShape(result.agreement),
        version: {
          id: result.version.id,
          versionNumber: result.version.versionNumber,
          terms: result.version.terms,
        },
        schedule: result.schedule,
      },
      { status: 201 },
    );
  };
}

const listQuerySchema = z.object({
  profileKind: z.enum(["personal", "business"]),
  profileId: z.string().uuid(),
});

export function createAgreementListHandler(
  authService: AuthService,
  agreementService: AgreementService,
  progressService: AgreementProgressService,
) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const url = new URL(request.url);
    const parsed = listQuerySchema.safeParse({
      profileKind: url.searchParams.get("profileKind"),
      profileId: url.searchParams.get("profileId"),
    });
    if (!parsed.success) throw new ValidationError("profileKind and profileId are required.");

    // PRSprint 26 (docs/prsprints/PRSPRINT_26_SEARCH_FILTER_PAGINATION_RECORD_MANAGEMENT.md):
    // server-side pagination — never an unbounded browser load, newest-first, stable across pages.
    const pageParams = parsePageParams(url.searchParams);
    const agreements = await agreementService.listAgreements(
      userId,
      { kind: parsed.data.profileKind, id: parsed.data.profileId },
      { limit: pageParams.limit + 1, offset: pageParams.offset },
    );
    const page = toPage(agreements, pageParams);
    // Agreement workflow remediation (Problem 3 — "the user should not have to open every agreement
    // to determine whether something requires attention"): reuses the exact same
    // AgreementProgressService every agreement detail page uses — never a second, competing
    // computation of "what's next" for the list view. UX-only: a single agreement's progress read
    // failing degrades that one card to no attention label rather than failing the whole list.
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

async function handleCreate(request: NextRequest): Promise<Response> {
  return createAgreementCreateHandler(getAuthService(), getAgreementService())(request);
}

async function handleList(request: NextRequest): Promise<Response> {
  return createAgreementListHandler(getAuthService(), getAgreementService(), getAgreementProgressService())(request);
}

export const POST = withErrorHandling("agreement_create", handleCreate);
export const GET = withErrorHandling("agreement_list", handleList);
