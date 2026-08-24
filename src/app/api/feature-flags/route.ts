import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Section H (closed-beta remediation, Product Owner review): `isFeatureEnabled` was previously only
 * ever consulted server-side (services and routes) — no client component could see a flag's real
 * value (including its env-var override), only feature-flags.ts's own hard-coded default. AppNav.tsx
 * needs the real `liveCardIssuanceEnabled` value to decide whether "Cards" belongs in the nav at all
 * (Option 2 — hide, don't fake — since no live card-issuing provider is registered anywhere in this
 * codebase yet). No auth required: which optional features are switched on is not sensitive, and this
 * must be reachable from the nav shell that renders on every authenticated page.
 */
async function handleGet(): Promise<Response> {
  return NextResponse.json({ liveCardIssuanceEnabled: isFeatureEnabled("liveCardIssuanceEnabled") }, { status: 200 });
}

export const GET = withErrorHandling("client_feature_flags", handleGet);
