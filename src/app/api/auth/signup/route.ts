import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { setSessionCookie } from "@/lib/auth/cookies";
import { getAuthService } from "@/lib/auth/getAuthService";
import type { BetaInviteService } from "@/lib/compliance/betaInviteService";
import { getBetaInviteService } from "@/lib/compliance/getBetaInviteService";
import { ValidationError, RateLimitedError } from "@/lib/errors";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const addressSchema = z.object({
  line1: z.string().trim().min(1),
  line2: z.string().trim().nullish(),
  city: z.string().trim().min(1),
  state: z.string().trim().min(1),
  postalCode: z.string().trim().min(1),
  country: z.string().trim().min(1),
});

const identitySchema = z.object({
  firstName: z.string().trim().min(1),
  middleName: z.string().trim().nullish(),
  lastName: z.string().trim().min(1),
  contactPhone: z.string().trim().min(1),
  address: addressSchema,
});

const businessAddressSchema = z.object({
  line1: z.string().trim().min(1),
  line2: z.string().trim().nullish(),
  city: z.string().trim().min(1),
  postalCode: z.string().trim().min(1),
});

// No SSN/ITIN/EIN number is ever accepted here — see docs/OPEN_ISSUES.md's tracked tax-ID provider
// dependency and BusinessSignupDetails's own doc comment in authService.ts.
const businessSchema = z.object({
  legalBusinessName: z.string().trim().min(1).max(200),
  dbaName: z.string().trim().nullish(),
  entityType: z.string().trim().min(1).max(100),
  businessPhone: z.string().trim().nullish(),
  businessAddress: businessAddressSchema,
  state: z.string().trim().min(1),
  country: z.string().trim().min(1).default("US"),
  taxIdType: z.enum(["EIN", "SSN", "ITIN"]),
});

const baseSignupFields = {
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(256),
  // Age eligibility (18+) is enforced by AuthService.signup itself — this
  // regex only validates shape, not the age business rule.
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be in YYYY-MM-DD format."),
  // PRSprint 33: only required/checked when closedBetaEnabled is on — see BetaInviteService's doc
  // comment for why the fast-fail pre-check lives here rather than inside AuthService.signup. The
  // actual authorization guarantee is now the atomic in-transaction claim inside AuthService.signup
  // itself (see AccountProvisioningRepository's doc comment).
  inviteCode: z.string().trim().nullish(),
};

const signupSchema = z.discriminatedUnion("accountType", [
  z.object({ accountType: z.literal("personal"), identity: identitySchema, ...baseSignupFields }),
  z.object({ accountType: z.literal("business"), identity: identitySchema, business: businessSchema, ...baseSignupFields }),
]);

// NFR-SEC-004: authentication endpoints are rate-limited per account/IP/device.
const SIGNUP_LIMIT_PER_IP = 5;
const SIGNUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Factory so this route is testable against an in-memory AuthService
 * (see route.test.ts) without a live database — the exported POST handler
 * below wires in the real, Drizzle-backed getAuthService() lazily, only when
 * a request actually arrives (mirrors src/db/client.ts's lazy pattern).
 */
export function createSignupHandler(authService: AuthService, betaInvites: BetaInviteService) {
  return async function handleSignup(request: NextRequest): Promise<Response> {
    const ip = getClientIp(request);
    if (!(await checkRateLimit(`signup:ip:${ip}`, SIGNUP_LIMIT_PER_IP, SIGNUP_WINDOW_MS))) {
      throw new RateLimitedError("Too many signup attempts. Please try again later.");
    }

    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = signupSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A complete, valid signup is required.");
    }

    // PRSprint 33 (docs/prsprints/PRSPRINT_33_FINAL_PRODUCTION_LAUNCH_CONTROLS_CLOSED_BETA.md): a
    // fast-fail pre-check, before AuthService.signup is ever called — an obviously invalid/missing
    // code during closed beta avoids hashing a password and opening a transaction for a signup that
    // can never succeed. The real correctness guarantee is the atomic claim inside AuthService.signup.
    const closedBeta = isFeatureEnabled("closedBetaEnabled");
    if (closedBeta) {
      await betaInvites.checkCodeIsRedeemable(parsed.data.inviteCode ?? "");
    }
    const inviteCode = closedBeta ? parsed.data.inviteCode ?? null : null;

    const identity = {
      firstName: parsed.data.identity.firstName,
      middleName: parsed.data.identity.middleName || null,
      lastName: parsed.data.identity.lastName,
      contactPhone: parsed.data.identity.contactPhone,
      address: { ...parsed.data.identity.address, line2: parsed.data.identity.address.line2 || null },
    };

    const { user, token, expiresAt } = await authService.signup(
      parsed.data.accountType === "personal"
        ? {
            accountType: "personal",
            email: parsed.data.email,
            password: parsed.data.password,
            dateOfBirth: parsed.data.dateOfBirth,
            identity,
            inviteCode,
            ipAddress: ip,
            userAgent: request.headers.get("user-agent"),
          }
        : {
            accountType: "business",
            email: parsed.data.email,
            password: parsed.data.password,
            dateOfBirth: parsed.data.dateOfBirth,
            identity,
            business: {
              legalBusinessName: parsed.data.business.legalBusinessName,
              dbaName: parsed.data.business.dbaName || null,
              entityType: parsed.data.business.entityType,
              businessPhone: parsed.data.business.businessPhone || null,
              businessAddress: {
                ...parsed.data.business.businessAddress,
                line2: parsed.data.business.businessAddress.line2 || null,
              },
              state: parsed.data.business.state,
              country: parsed.data.business.country,
              taxIdType: parsed.data.business.taxIdType,
            },
            inviteCode,
            ipAddress: ip,
            userAgent: request.headers.get("user-agent"),
          },
    );

    const response = NextResponse.json({ id: user.id, email: user.email }, { status: 201 });
    setSessionCookie(response, token, expiresAt);
    return response;
  };
}

async function handleSignup(request: NextRequest): Promise<Response> {
  return createSignupHandler(getAuthService(), getBetaInviteService())(request);
}

export const POST = withErrorHandling("auth_signup", handleSignup);
