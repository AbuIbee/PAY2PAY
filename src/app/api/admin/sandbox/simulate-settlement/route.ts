import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { isAdminRole } from "@/lib/admin/capabilities";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ConfigurationError, ForbiddenError, ValidationError } from "@/lib/errors";
import { getPaymentProvider, getSandboxPaymentProviderInstance } from "@/lib/payments/getPaymentProvider";
import { getPaymentWebhookService } from "@/lib/payments/getPaymentWebhookService";
import type { PaymentWebhookService } from "@/lib/payments/paymentWebhookService";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import type { PaymentAttemptRepository } from "@/lib/payments/paymentService";
import type { PaymentProvider } from "@/lib/payments/paymentProvider";

/** Narrow view onto SandboxPaymentProvider — only the one method this route needs. */
export interface WebhookPayloadSigner {
  signWebhookPayload(rawBody: string): string;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  paymentAttemptId: z.string().uuid(),
  outcome: z.enum(["succeeded", "failed"]),
  failureCategory: z.string().trim().max(200).optional(),
});

/**
 * Restore agreement payment functionality: admin-only, sandbox-only endpoint that drives a real,
 * webhook-verified settlement for a specific payment attempt — needed to make "confirm the
 * webhook/provider result updates payment status" independently verifiable end-to-end without direct
 * access to the raw PAYMENT_SANDBOX_WEBHOOK_SECRET (a Vercel-"Sensitive" value). This is NOT a
 * shortcut around the real webhook pipeline — it constructs a genuine payload, signs it with the
 * real secret (server-side, via SandboxPaymentProvider.signWebhookPayload), and feeds it through the
 * exact same PaymentWebhookService.receiveWebhook path a real provider webhook would use. Refuses
 * outright unless the configured payment provider is actually the sandbox — structurally incapable
 * of touching a real processor.
 */
export function createSimulateSettlementHandler(
  authService: AuthService,
  paymentAttempts: PaymentAttemptRepository,
  paymentWebhookService: PaymentWebhookService,
  provider: PaymentProvider,
  signer: WebhookPayloadSigner,
) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { platformRole } = await requireSession(request, authService);
    if (!isAdminRole(platformRole)) {
      throw new ForbiddenError("Administrative access is required.");
    }

    if (provider.providerEnvironment !== "sandbox") {
      throw new ConfigurationError("Settlement simulation is only available when the sandbox payment provider is active.");
    }

    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid simulation request is required.");
    }

    const payment = await paymentAttempts.findById(parsed.data.paymentAttemptId);
    if (!payment || !payment.providerPaymentId) {
      throw new ValidationError("This payment attempt has no provider reference to simulate settlement against.");
    }

    const eventBody = JSON.stringify({
      providerEventId: `sim_${randomUUID()}`,
      eventType: parsed.data.outcome === "succeeded" ? "payment.succeeded" : "payment.failed",
      providerPaymentId: payment.providerPaymentId,
      ...(parsed.data.outcome === "failed" ? { failureCategory: parsed.data.failureCategory ?? "simulated_failure" } : {}),
    });
    const signatureHeader = signer.signWebhookPayload(eventBody);

    const result = await paymentWebhookService.receiveWebhook({ rawBody: eventBody, signatureHeader });
    return NextResponse.json({ status: result.status }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  const provider = getPaymentProvider();
  return createSimulateSettlementHandler(
    getAuthService(),
    new DrizzlePaymentAttemptRepository(),
    getPaymentWebhookService(),
    provider,
    getSandboxPaymentProviderInstance(),
  )(request);
}

export const POST = withErrorHandling("admin_sandbox_simulate_settlement", handlePost);
