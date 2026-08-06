import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { toSafeErrorResponse } from "@/lib/errors";

/**
 * Wraps a Next.js Route Handler so every uncaught error is logged
 * server-side (with full detail) and converted into a safe, consistent JSON
 * error response (with only what's safe to expose) — centralized error
 * handling per docs/IMPLEMENTATION_PLAN.md Phase 0.
 */
export function withErrorHandling<Args extends unknown[]>(
  routeName: string,
  handler: (...args: Args) => Promise<Response>,
) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      logger.error(`${routeName}_failed`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      const safe = toSafeErrorResponse(error);
      return NextResponse.json(
        { status: "error", code: safe.code, message: safe.message },
        { status: safe.statusCode },
      );
    }
  };
}
