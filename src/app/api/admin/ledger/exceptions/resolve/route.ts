import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getLedgerAdminService } from "@/lib/ledger/getLedgerAdminService";
import type { LedgerAdminService } from "@/lib/ledger/ledgerAdminService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resolveSchema = z.object({
  exceptionId: z.string().uuid(),
  resolutionReason: z.string().trim().min(1).max(2000),
});

export function createAdminLedgerExceptionResolveHandler(authService: AuthService, ledgerAdminService: LedgerAdminService) {
  return async function handleResolve(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = resolveSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid resolution request is required.");
    }

    const resolved = await ledgerAdminService.resolveException(
      platformRole,
      userId,
      parsed.data.exceptionId,
      parsed.data.resolutionReason,
    );
    return NextResponse.json(resolved, { status: 200 });
  };
}

async function handleResolve(request: NextRequest): Promise<Response> {
  return createAdminLedgerExceptionResolveHandler(getAuthService(), getLedgerAdminService())(request);
}

export const POST = withErrorHandling("admin_ledger_exception_resolve", handleResolve);
