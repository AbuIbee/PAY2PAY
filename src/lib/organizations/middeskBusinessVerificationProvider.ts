import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ConfigurationError, ProviderCapabilityUnsupportedError } from "@/lib/errors";
import type {
  BusinessVerificationProvider,
  BusinessVerificationResultStatus,
  ParsedBusinessVerificationWebhookEvent,
  RetrieveBusinessVerificationStatusResult,
  SubmitBusinessVerificationInput,
  SubmitBusinessVerificationResult,
} from "./businessVerificationProvider";

const DEFAULT_API_BASE_URL = "https://api.middesk.com";

/**
 * "PAID2YOU — MASTER P0" (2026-10-03), Section 10-16: real Middesk Business Verification API
 * adapter, implementing the existing `BusinessVerificationProvider` interface directly (no parallel
 * verification subsystem). Grounded against Middesk's own published API documentation
 * (docs.middesk.com) as of this writing:
 *
 *   - POST {base}/v1/businesses creates a verification ("Authorization: Bearer <token>").
 *   - GET {base}/v1/businesses/:id retrieves current status.
 *   - Status values: open, pending, in_audit, in_review, approved, rejected.
 *   - Webhook signature: header "X-Middesk-Signature-256", HMAC-SHA256 of the RAW request body,
 *     hex-encoded, compared against the delivered header value.
 *   - Webhook event envelope: { object: "event", id, type, data: { object: {...} }, created_at }.
 *
 * STATUS NOTE (Section 68 — do not conflate "code complete" with "live verified"): this mapping was
 * derived from Middesk's documentation site, not from an authenticated call against a real Middesk
 * account/sandbox (no credentials exist in this environment to make one — Section 11's own "do not
 * create provider accounts/credentials" boundary). An operator with real Middesk credentials must
 * exercise this adapter against Middesk's own test mode before any live-production business
 * verification is attempted (see docs/FIRST_LIVE_BUSINESS_ACCEPTANCE.md) — this is CODE COMPLETE, not
 * LIVE VERIFIED.
 *
 * REVIEWER NOTE (Section 13/16): Middesk's own lifecycle does NOT autonomously decide
 * "approved"/"rejected" — "in_review" means Middesk has finished its investigation and is waiting for
 * the API CONSUMER (Paid2You) to approve or reject, typically via Middesk's own hosted console. This
 * adapter maps "in_review" to this application's existing "review_required" status (Section 13's own
 * "do not invent new states unless required to safely map a provider fact" — this one already exists
 * in BusinessVerificationResultStatus) rather than inventing an auto-decision policy this codebase has
 * no product mandate to make (Section 16: "a manual review path... must NOT be automatic"). Approving
 * or rejecting an `in_review` business is an OWNER/OPERATOR action taken in Middesk's own dashboard —
 * documented in docs/OWNER_LAUNCH_ACTIONS.md — never something this adapter decides for itself.
 *
 * DATA MINIMIZATION (Section 12): `taxId` is sent to Middesk exactly once, inside `submitVerification`,
 * as part of the outbound request body — never logged (no `console.*`/logger call in this file ever
 * includes it), never echoed back in any return value, never retried with the same error context (a
 * thrown ConfigurationError/network error here carries only Middesk's own safe error message, never
 * the request body). `retrieveVerificationStatus`'s response is Middesk's own result — Middesk does
 * not echo the raw TIN back in its business-status payload either (`tin_result`/similar fields are
 * pass/fail summaries, not the number itself); this adapter only ever reads safe summary fields off
 * that response, never a raw TIN field, so even an unexpected Middesk response shape cannot leak one
 * through this code.
 */
export class MiddeskBusinessVerificationProvider implements BusinessVerificationProvider {
  readonly providerName = "middesk";
  readonly providerEnvironment = "production" as const;

  constructor(
    private readonly config: {
      apiKey: string;
      webhookSecret: string;
      apiBaseUrl?: string;
    },
  ) {}

  private get baseUrl(): string {
    return this.config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  }

  async submitVerification(input: SubmitBusinessVerificationInput): Promise<SubmitBusinessVerificationResult> {
    const address = input.businessAddress as Record<string, unknown>;
    const body = {
      name: input.legalBusinessName,
      tin: { tin: input.taxId },
      addresses: [
        {
          address_line1: typeof address.line1 === "string" ? address.line1 : undefined,
          address_line2: typeof address.line2 === "string" ? address.line2 : undefined,
          address_city: typeof address.city === "string" ? address.city : undefined,
          address_state: typeof address.state === "string" ? address.state : undefined,
          address_zip: typeof address.postalCode === "string" ? address.postalCode : undefined,
        },
      ],
      // Middesk's "Business Owners" / person sub-resource is a separate, optional create call this
      // adapter does not invoke — the authorized representative is retained only in this
      // application's own business_profile (never sent to, or required by, the base Middesk business
      // verification create call per its documented request shape above). Never fabricated/guessed.
    };

    const response = await this.request("POST", "/v1/businesses", body);
    const id = response.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new ConfigurationError("Middesk business creation response did not include an \"id\".");
    }
    return { providerReference: id };
  }

  async retrieveVerificationStatus(providerReference: string): Promise<RetrieveBusinessVerificationStatusResult> {
    const response = await this.request("GET", `/v1/businesses/${encodeURIComponent(providerReference)}`, undefined);
    return this.mapBusinessResponse(providerReference, response);
  }

  /**
   * "PAID2YOU — SURGICAL FINAL P0 REMEDIATION" (2026-10-04), P0-2: `failureCode` is a CLOSED,
   * Paid2You-defined value — never Middesk's own free-text `review.reason`. That field can legally
   * contain business/TIN-adjacent commentary a Middesk reviewer typed, and this value flows straight
   * into persistent storage (`business_verification.failure_code`) and audit `newValue.failureCode`
   * (see BusinessVerificationService.applyVerificationResult) — neither of which sanitizes it. Middesk
   * currently exposes only one rejection outcome in this mapping, so the closed enum is a single fixed
   * literal; if Middesk ever adds distinguishable rejection sub-reasons, map each to its own
   * Paid2You-defined literal here — never pass provider wording through.
   */
  private mapBusinessResponse(providerReference: string, response: Record<string, unknown>): RetrieveBusinessVerificationStatusResult {
    const rawStatus = typeof response.status === "string" ? response.status : "pending";
    const status = mapMiddeskStatus(rawStatus);
    return {
      providerReference,
      status,
      reviewRequired: status === "review_required",
      failureCode: status === "rejected" ? "rejected" : undefined,
    };
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    if (!signatureHeader) return false;
    const expected = createHmac("sha256", this.config.webhookSecret).update(rawBody, "utf8").digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    const providedBuf = Buffer.from(signatureHeader.trim(), "hex");
    if (expectedBuf.length !== providedBuf.length) return false;
    return timingSafeEqual(expectedBuf, providedBuf);
  }

  parseWebhookEvent(rawBody: string): ParsedBusinessVerificationWebhookEvent {
    let parsed: { id?: unknown; type?: unknown; data?: unknown };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      throw new ConfigurationError("Middesk webhook payload is not valid JSON.");
    }
    if (typeof parsed.id !== "string" || typeof parsed.type !== "string") {
      throw new ConfigurationError("Middesk webhook payload is missing \"id\"/\"type\".");
    }
    const rawObject = (parsed.data as { object?: Record<string, unknown> } | undefined)?.object ?? {};
    const data = sanitizeMiddeskWebhookBusinessObject(rawObject);
    return { provider: this.providerName, providerEventId: parsed.id, eventType: parsed.type, data };
  }

  private async request(method: "GET" | "POST", path: string, body: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      // "PAID2YOU — SURGICAL FINAL P0 REMEDIATION" (2026-10-04), P0-2: never interpolate the caught
      // network/fetch exception's own `.message` into this thrown error — it is library/runtime text
      // outside Paid2You's control and `withErrorHandling`'s generic catch-all logs this message
      // verbatim. Only safe, application-controlled values (request path) ever appear here.
      throw new ProviderCapabilityUnsupportedError(`Middesk request to ${path} failed to reach the network.`);
    }
    const text = await response.text();
    let json: Record<string, unknown> = {};
    if (text) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new ConfigurationError(`Middesk returned a non-JSON response from ${path} (status ${response.status}).`);
      }
    }
    if (!response.ok) {
      // "PAID2YOU — CODEX P0 DEFECT REMEDIATION", P0-2: never echo Middesk's own response body text
      // into a thrown error — it could legally contain business/TIN-adjacent content Middesk chose to
      // put in an error message, and this error's own `.message` is exactly what ends up in
      // structured application logs (withErrorHandling's generic catch-all logs `error.message`
      // verbatim). Only safe, application-controlled values — provider name, request path, HTTP
      // status — ever appear here, never any field read from `json`.
      throw new ConfigurationError(`Middesk request to ${path} failed with status ${response.status}.`);
    }
    return json;
  }
}

/**
 * "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-2: the Middesk webhook's own "business"
 * object can legally carry TIN-adjacent fields (`tin`, `tin_result`, Middesk's own "Business Owners"
 * sub-resource references, etc.) — Section 9's own "Raw EIN/Tax ID... NEVER persistent webhook
 * JSONB... NEVER logs... NEVER audit metadata" rule applies here exactly as it already does to
 * `submitVerification`'s own raw TIN handling. `BusinessVerificationWebhookService.receiveWebhook`
 * persists `parsed.data` verbatim into `business_verification_webhook_event.payload` (jsonb) for
 * observability — `applyEvent` itself only ever reads `data.id` (the status is always re-fetched live
 * from `retrieveVerificationStatus`, never trusted from the webhook body — see that service's own doc
 * comment), so nothing downstream needs more than this ALLOWLIST already provides. An allowlist (never
 * a denylist of "known-bad" fields) is deliberate — a denylist only ever protects against sensitive
 * fields someone already thought to name.
 */
function sanitizeMiddeskWebhookBusinessObject(rawObject: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (typeof rawObject.id === "string") safe.id = rawObject.id;
  if (typeof rawObject.status === "string") safe.status = rawObject.status;
  if (typeof rawObject.created_at === "string") safe.created_at = rawObject.created_at;
  if (typeof rawObject.updated_at === "string") safe.updated_at = rawObject.updated_at;
  // `review.reason` (not the raw TIN itself, but still provider-authored free text about WHY a
  // business is under review) is deliberately NOT included here. "PAID2YOU — SURGICAL FINAL P0
  // REMEDIATION" (2026-10-04), P0-2: `mapBusinessResponse` no longer reads `review.reason` at all —
  // `failureCode` is now always a fixed, Paid2You-defined literal, never provider wording — so this
  // field has no safe or unsafe path into the application anywhere, webhook or polled alike.
  return safe;
}

/**
 * Section 13: maps Middesk's six documented statuses onto this application's existing
 * BusinessVerificationResultStatus — never a fabricated "verified" for anything short of Middesk's
 * own "approved" decision (Section 13's own "a successful HTTP/API submission is NOT a successful
 * Business verification").
 */
export function mapMiddeskStatus(rawStatus: string): BusinessVerificationResultStatus {
  switch (rawStatus) {
    case "approved":
      return "verified";
    case "rejected":
      return "rejected";
    case "in_review":
      return "review_required";
    case "open":
    case "pending":
    case "in_audit":
    default:
      return "pending";
  }
}
