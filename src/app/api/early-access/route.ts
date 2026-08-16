import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { ValidationError, RateLimitedError } from "@/lib/errors";
import type { EarlyAccessLeadRepository } from "@/lib/early-access/earlyAccessLeadRepository";
import { getEarlyAccessLeadRepository } from "@/lib/early-access/getEarlyAccessLeadRepository";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request-ip";
import { logger } from "@/lib/logger";
import { US_STATE_CODES } from "@/lib/us-states";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sprint 1 item 6: this is the exhaustive field list. Do NOT add bank
// account, routing number, SSN, EIN, payment card, or government-ID fields
// here — Sprint 1 explicitly forbids collecting them at this stage.
const earlyAccessSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required.").max(200),
    email: z.string().trim().toLowerCase().email("A valid email is required.").max(254),
    accountType: z.enum(["individual", "business"], {
      message: "Account type must be individual or business.",
    }),
    businessName: z.string().trim().max(200).optional(),
    state: z.enum(US_STATE_CODES, { message: "A valid US state or territory is required." }),
    intendedUse: z.string().trim().min(1, "Please describe your intended use.").max(1000),
    expectedAgreementsPerMonth: z.coerce
      .number()
      .int()
      .min(0)
      .max(1_000_000, "That number looks too large — please contact us directly instead."),
    notes: z.string().trim().max(2000).optional(),
    // Honeypot: a real visitor never sees or fills this field (src/components/EarlyAccessForm.tsx
    // keeps it visually hidden and out of tab order). A non-empty value here means the
    // submission almost certainly came from an automated bot, not server-validated user intent.
    website: z.string().max(500).optional(),
  })
  .refine((data) => data.accountType !== "business" || !!data.businessName, {
    message: "Business name is required for a business account type.",
    path: ["businessName"],
  });

const EARLY_ACCESS_LIMIT_PER_IP = 5;
const EARLY_ACCESS_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const EARLY_ACCESS_SOURCE = "landing_page";
// Bumped whenever the consent/privacy copy shown alongside the form changes.
// "v0-unfinished" flags that the privacy/terms text this consent refers to is
// a placeholder, not final legal copy (docs/sprints/SPRINT_01... item 10).
const EARLY_ACCESS_CONSENT_VERSION = "v0-unfinished";

/**
 * Factory so this route is testable against an in-memory repository (see
 * route.test.ts) without a live database — mirrors
 * src/app/api/auth/signup/route.ts's createSignupHandler pattern.
 */
export function createEarlyAccessHandler(repository: EarlyAccessLeadRepository) {
  return async function handleEarlyAccess(request: NextRequest): Promise<Response> {
    const ip = getClientIp(request);
    if (!(await checkRateLimit(`early-access:ip:${ip}`, EARLY_ACCESS_LIMIT_PER_IP, EARLY_ACCESS_WINDOW_MS))) {
      throw new RateLimitedError("Too many submissions. Please try again later.");
    }

    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = earlyAccessSchema.safeParse(rawBody);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new ValidationError(firstIssue?.message ?? "Invalid submission.");
    }

    if (parsed.data.website) {
      // Honeypot tripped — report success without revealing detection or
      // touching the database, per standard bot-mitigation practice.
      logger.warn("early_access_honeypot_triggered", { ip });
      return NextResponse.json({ status: "ok" }, { status: 201 });
    }

    const { id } = await repository.upsertByEmail({
      name: parsed.data.name,
      email: parsed.data.email,
      accountType: parsed.data.accountType,
      businessName: parsed.data.accountType === "business" ? parsed.data.businessName ?? null : null,
      state: parsed.data.state,
      intendedUse: parsed.data.intendedUse,
      expectedAgreementsPerMonth: parsed.data.expectedAgreementsPerMonth,
      notes: parsed.data.notes ?? null,
      source: EARLY_ACCESS_SOURCE,
      consentVersion: EARLY_ACCESS_CONSENT_VERSION,
    });

    return NextResponse.json({ status: "ok", id }, { status: 201 });
  };
}

async function handleEarlyAccess(request: NextRequest): Promise<Response> {
  return createEarlyAccessHandler(getEarlyAccessLeadRepository())(request);
}

export const POST = withErrorHandling("early_access_submit", handleEarlyAccess);
