import "server-only";
import { randomUUID } from "node:crypto";
import { ValidationError } from "@/lib/errors";
import { computeHmacSignature, verifyHmacSignature } from "@/lib/webhookSignature";
import type {
  CancelPaymentResult,
  CreatePaymentInput,
  CreatePaymentMethodTokenInput,
  CreatePaymentMethodTokenResult,
  CreatePaymentResult,
  CreateRecipientAccountInput,
  CreateRecipientAccountResult,
  LinkBankAccountInput,
  LinkBankAccountResult,
  ParsedWebhookEvent,
  PaymentProvider,
  PaymentProviderPaymentStatus,
  RefundPaymentResult,
  RetrievePaymentResult,
  TokenizeBankAccountInput,
  TokenizeBankAccountResult,
} from "./paymentProvider";

interface StoredSandboxPayment {
  status: PaymentProviderPaymentStatus;
  amountMinorUnits: number;
}

/**
 * Sprint 9's sandbox/mock PaymentProvider — NOT a real Stripe/Plaid sandbox integration (this
 * environment has no live processor credentials). Every operation is a deterministic, purely local
 * simulation; nothing here ever reaches a real network or moves real money ("NO PRODUCTION MONEY"
 * per this sprint's text). The one piece of *real* behavior is the webhook HMAC signing/verification
 * — that cryptography is genuine and correctly implemented, standing in for wherever a real
 * processor's own signing scheme would sit, so "webhook spoof" tests exercise real signature
 * rejection rather than a tautology.
 *
 * No UI may present a sandbox transaction as real; the caller (PaymentService/routes) is
 * responsible for surfacing `providerName` so downstream code/consumers can tell.
 */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly providerName = "sandbox_mock";
  readonly providerEnvironment = "sandbox" as const;
  private readonly payments = new Map<string, StoredSandboxPayment>();

  constructor(private readonly webhookSecret: string) {}

  async createRecipientAccount(_input: CreateRecipientAccountInput): Promise<CreateRecipientAccountResult> {
    return { providerAccountId: `sandbox_acct_${randomUUID()}`, payoutCapable: true };
  }

  async linkBankAccount(_input: LinkBankAccountInput): Promise<LinkBankAccountResult> {
    return { providerBankAccountRef: `sandbox_bank_${randomUUID()}` };
  }

  async createPaymentMethodToken(_input: CreatePaymentMethodTokenInput): Promise<CreatePaymentMethodTokenResult> {
    return { providerPaymentMethodToken: `sandbox_pm_${randomUUID()}` };
  }

  /**
   * Phase 6A fallback-architecture tokenization boundary (see TokenizeBankAccountInput's doc comment).
   * `input.routingNumber`/`input.accountNumber` are read exactly once, here, to derive a masked last4
   * and a fresh opaque reference — neither raw value is ever assigned to `this.payments`, a class
   * field, a log call, or any other structure that would outlive this method call. `accountHolderName`
   * is accepted (a real provider would use it for identity-matching/Reg E purposes) but is likewise
   * never retained beyond this call.
   */
  async tokenizeBankAccount(input: TokenizeBankAccountInput): Promise<TokenizeBankAccountResult> {
    if (!/^\d{9}$/.test(input.routingNumber)) {
      throw new ValidationError("Routing number must be exactly 9 digits.");
    }
    if (!/^\d{4,17}$/.test(input.accountNumber)) {
      throw new ValidationError("Account number must be between 4 and 17 digits.");
    }
    const maskedLast4 = input.accountNumber.slice(-4);
    return { providerAccountRef: `sandbox_bank_${randomUUID()}`, maskedLast4 };
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (!Number.isInteger(input.amountMinorUnits) || input.amountMinorUnits <= 0) {
      throw new ValidationError("amountMinorUnits must be a positive integer.");
    }
    if (input.simulateOutcome === "processor_error") {
      throw new Error("sandbox_processor_unavailable");
    }
    const status: PaymentProviderPaymentStatus = input.simulateOutcome ?? "pending";
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    this.payments.set(providerPaymentId, { status, amountMinorUnits: input.amountMinorUnits });
    return { providerPaymentId, status };
  }

  async retrievePayment(providerPaymentId: string): Promise<RetrievePaymentResult> {
    const record = this.payments.get(providerPaymentId);
    if (!record) throw new ValidationError("Unknown payment reference.");
    return { providerPaymentId, status: record.status };
  }

  async cancelPayment(providerPaymentId: string): Promise<CancelPaymentResult> {
    const record = this.payments.get(providerPaymentId);
    if (!record || record.status !== "pending") return { canceled: false };
    record.status = "failed";
    return { canceled: true };
  }

  async refundPayment(providerPaymentId: string, _amountMinorUnits?: number): Promise<RefundPaymentResult> {
    const record = this.payments.get(providerPaymentId);
    if (!record || record.status !== "succeeded") {
      throw new ValidationError("Only a succeeded payment can be refunded.");
    }
    return { providerRefundId: `sandbox_refund_${randomUUID()}` };
  }

  /** Marks a stored sandbox payment succeeded — used by the sandbox webhook simulator/tests to model async settlement. */
  simulateSettlement(providerPaymentId: string, status: PaymentProviderPaymentStatus): void {
    const record = this.payments.get(providerPaymentId);
    if (record) record.status = status;
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    return verifyHmacSignature(rawBody, signatureHeader, this.webhookSecret);
  }

  parseWebhookEvent(rawBody: string): ParsedWebhookEvent {
    let parsed: { providerEventId?: unknown; eventType?: unknown; [key: string]: unknown };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      throw new ValidationError("Webhook payload is not valid JSON.");
    }
    if (typeof parsed.providerEventId !== "string" || typeof parsed.eventType !== "string") {
      throw new ValidationError("Webhook payload is missing providerEventId/eventType.");
    }
    return {
      provider: this.providerName,
      providerEventId: parsed.providerEventId,
      eventType: parsed.eventType,
      data: parsed,
    };
  }

  /** Test/sandbox-simulator helper — produces a signature a real caller would send in the webhook's signature header. */
  signWebhookPayload(rawBody: string): string {
    return computeHmacSignature(rawBody, this.webhookSecret);
  }
}
