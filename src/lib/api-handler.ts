import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { isServerFault, toSafeErrorResponse } from "@/lib/errors";

/**
 * Wraps a Next.js Route Handler so every uncaught error is logged
 * server-side (with full detail) and converted into a safe, consistent JSON
 * error response (with only what's safe to expose) — centralized error
 * handling per docs/IMPLEMENTATION_PLAN.md Phase 0.
 *
 * PRSprint 28 (docs/prsprints/PRSPRINT_28_ERROR_HANDLING_OBSERVABILITY_HEALTH_MONITORING.md):
 * every failure gets a `correlationId` — logged server-side alongside the route name and full error
 * detail, and, for a genuine server fault (5xx) only, returned to the client so a user can hand it to
 * support and an operator can grep the exact log line. A 4xx (validation/auth/rate-limit) never
 * includes one — the message alone is already actionable, and minting an id for every routine
 * rejection would just be log noise.
 */
export function withErrorHandling<Args extends unknown[]>(
  routeName: string,
  handler: (...args: Args) => Promise<Response>,
) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      const safe = toSafeErrorResponse(error);
      const correlationId = randomUUID();
      // Agreement Lifecycle V2 UAT (Send secure invitation "Unexpected error occurred"): a wrapped
      // driver/ORM error (e.g. postgres.js/drizzle's own "Failed query: ..." message) hides the real
      // underlying database error in `.cause` — logging only `.message`/`.stack` made the actual
      // failure undiagnosable from server logs alone. Captured one level deep, matching the shape
      // ad-hoc call sites elsewhere in this codebase already log (`causeName`/`causeCode`/`causeMessage`).
      const cause = error instanceof Error ? error.cause : undefined;
      logger.error(`${routeName}_failed`, {
        correlationId,
        route: routeName,
        statusCode: safe.statusCode,
        code: safe.code,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        ...(cause instanceof Error
          ? { causeName: cause.name, causeMessage: cause.message, causeCode: (cause as { code?: string }).code }
          : cause !== undefined
            ? { cause: String(cause) }
            : {}),
      });
      return NextResponse.json(
        {
          status: "error",
          code: safe.code,
          message: safe.message,
          ...(isServerFault(safe.statusCode) ? { correlationId } : {}),
        },
        { status: safe.statusCode },
      );
    }
  };
}
