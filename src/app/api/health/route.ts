import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";

// Always run on the Node.js runtime (not edge) and never statically cache —
// a health check must reflect the live process, not a build-time snapshot.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 0 health check deliberately does not touch the database or any
 * external provider — none exist yet (docs/IMPLEMENTATION_PLAN.md Phase 0
 * has no processor/KYC dependency), and a health endpoint that requires
 * secrets just to report liveness would defeat its own purpose. Later
 * phases can extend this with real dependency checks (DB reachability,
 * queue connectivity) once those exist.
 */
async function handleGet(): Promise<Response> {
  const payload = {
    status: "ok" as const,
    service: "pay2pay",
    environment: process.env.APP_ENV ?? "development",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  };
  return NextResponse.json(payload, { status: 200 });
}

export const GET = withErrorHandling("health_check", handleGet);
