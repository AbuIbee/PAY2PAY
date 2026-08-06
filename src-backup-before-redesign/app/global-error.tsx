"use client";

import { useEffect } from "react";
import { logger } from "@/lib/logger";

/**
 * Root-level error boundary. Catches errors thrown by the root layout
 * itself, so it must render its own <html>/<body> (Next.js convention).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error("global_error_boundary", { message: error.message, digest: error.digest });
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div role="alert" style={{ padding: "1.5rem" }}>
          <h1>Something went wrong</h1>
          <p>An unexpected error occurred. You can try again.</p>
          <button type="button" onClick={() => reset()}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
