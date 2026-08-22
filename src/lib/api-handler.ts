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
      logger.error(`${routeName}_failed`, {
        correlationId,
        route: routeName,
        statusCode: safe.statusCode,
        code: safe.code,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
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
