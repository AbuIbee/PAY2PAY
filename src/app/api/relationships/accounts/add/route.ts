import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { RelationshipFinancialAccountService } from "@/lib/relationships/relationshipFinancialAccountService";
import { getRelationshipFinancialAccountService } from "@/lib/relationships/getRelationshipFinancialAccountService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const addAccountSchema = z.object({
  actingParty: z.object({ kind: z.enum(["personal", "business"]), id: z.string().uuid() }),
  accountType: z.enum(["bank_account", "debit_card"]),
  providerName: z.string().trim().min(1).max(200),
  providerAccountRef: z.string().trim().min(1).max(500),
  maskedLast4: z.string().trim().max(8).nullable().optional(),
  institutionDisplayName: z.string().trim().max(200).nullable().optional(),
  // Required by RelationshipFinancialAccountService.addAccount when accountType is "debit_card" —
  // validated there (not here), mirroring debit_card_method's own NOT NULL expiry columns (Sprint 12).
  cardExpiryMonth: z.number().int().min(1).max(12).nullable().optional(),
  cardExpiryYear: z.number().int().min(2000).nullable().optional(),
  cardBrand: z.string().trim().max(50).nullable().optional(),
});

/**
 * POST /api/relationships/accounts/add — Phase 15's bank-account-addition flow, generalized to any
 * party-owned financial account type. `providerAccountRef` must already be an opaque provider/
 * tokenization-boundary reference by the time it reaches this route — this route never sees or logs a
 * raw account/routing number, PAN, or CVV, matching Phase 15's explicit "never expose raw provider
 * secrets to client code, never log full bank details."
 */
export function createRelationshipAddAccountHandler(authService: AuthService, financialAccountService: RelationshipFinancialAccountService) {
  return async function handleAddAccount(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = addAccountSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid financial account payload is required.");
    }
    const account = await financialAccountService.addAccount({
      actingUserId: userId,
      actingParty: parsed.data.actingParty,
      accountType: parsed.data.accountType,
      providerName: parsed.data.providerName,
      providerAccountRef: parsed.data.providerAccountRef,
      maskedLast4: parsed.data.maskedLast4 ?? null,
      institutionDisplayName: parsed.data.institutionDisplayName ?? null,
      cardExpiryMonth: parsed.data.cardExpiryMonth ?? null,
      cardExpiryYear: parsed.data.cardExpiryYear ?? null,
      cardBrand: parsed.data.cardBrand ?? null,
    });
    return NextResponse.json({ account }, { status: 201 });
  };
}

async function handleAddAccount(request: NextRequest): Promise<Response> {
  return createRelationshipAddAccountHandler(getAuthService(), getRelationshipFinancialAccountService())(request);
}

export const POST = withErrorHandling("relationship_account_add", handleAddAccount);
