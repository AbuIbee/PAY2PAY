"use client";

import { useEffect } from "react";
import { logger } from "@/lib/logger";

/**
 * Route-level error boundary. Next.js requires this to be a Client
 * Component. Logs the full error server/browser-console-side, but only ever
 * shows the user a generic, safe message — matching the
 * toSafeErrorResponse convention used for API routes (src/lib/errors.ts).
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error("route_error_boundary", { message: error.message, digest: error.digest });
  }, [error]);

  return (
    <div role="alert">
      <h1>Something went wrong</h1>
      <p>An unexpected error occurred. You can try again.</p>
      <button type="button" className="button" onClick={() => reset()}>
        Try again
      </button>
    </div>
  );
}
