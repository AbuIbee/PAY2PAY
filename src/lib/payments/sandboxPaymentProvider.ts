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
  currency: string;
  payerProfileKind: string;
  payerProfileId: string;
  recipientProfileKind: string;
  recipientProfileId: string;
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
  /**
   * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 3): real adapter-level idempotency
   * — the durable memory a genuine processor keeps against the caller's own idempotency key. Every
   * `createPayment` call consults this FIRST, before ever minting a new `providerPaymentId`.
   */
  private readonly byIdempotencyKey = new Map<string, string>();

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

  /**
   * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 3): real idempotency semantics —
   * for the SAME `idempotencyKey`, this returns the SAME logical payment every time, never a second
   * one, matching a genuine processor's own idempotency-key contract. A same-key call with materially
   * different request data (amount/currency/either party's FULL reference — `profileKind` AND
   * `profileId`, per Codex's own Section 6 finding: the same `profileId` reused under a DIFFERENT
   * `profileKind` — e.g. personal -> business — is a genuinely different real-world party, not the
   * same request replayed) is rejected rather than silently creating or mutating a different logical
   * payment underneath the same key.
   */
  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const existingId = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.payments.get(existingId);
      if (!existing) throw new ValidationError("sandbox_idempotency_key_index_corrupted");
      const conflicts =
        existing.amountMinorUnits !== input.amountMinorUnits ||
        existing.currency !== input.currency ||
        existing.payerProfileKind !== input.payer.profileKind ||
        existing.payerProfileId !== input.payer.profileId ||
        existing.recipientProfileKind !== input.recipient.profileKind ||
        existing.recipientProfileId !== input.recipient.profileId;
      if (conflicts) {
        throw new ValidationError("This idempotency key was already used with different payment details.");
      }
      // Idempotent replay: the SAME logical payment, never a second one, never re-simulated.
      return { providerPaymentId: existingId, status: existing.status };
    }

    if (!Number.isInteger(input.amountMinorUnits) || input.amountMinorUnits <= 0) {
      throw new ValidationError("amountMinorUnits must be a positive integer.");
    }
    if (input.simulateOutcome === "processor_error") {
      throw new Error("sandbox_processor_unavailable");
    }
    const status: PaymentProviderPaymentStatus = input.simulateOutcome ?? "pending";
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    this.payments.set(providerPaymentId, {
      status,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      payerProfileKind: input.payer.profileKind,
      payerProfileId: input.payer.profileId,
      recipientProfileKind: input.recipient.profileKind,
      recipientProfileId: input.recipient.profileId,
    });
    this.byIdempotencyKey.set(input.idempotencyKey, providerPaymentId);
    return { providerPaymentId, status };
  }

  /**
   * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B2 — Part B): `feeMinorUnits` is
   * always explicitly `0` — this sandbox never simulates a processor fee at the provider-API layer
   * (mirrors `SANDBOX_ACH_PROCESSOR_FEE_MINOR_UNITS`'s identical "no live processor integrated"
   * baseline elsewhere in this codebase) — normalized HERE, inside the adapter, never left absent for
   * generic webhook/ledger code to guess about.
   */
  private toRetrieveResult(providerPaymentId: string, record: StoredSandboxPayment): RetrievePaymentResult {
    return { providerPaymentId, status: record.status, amountMinorUnits: record.amountMinorUnits, currency: record.currency, feeMinorUnits: 0 };
  }

  async retrievePayment(providerPaymentId: string): Promise<RetrievePaymentResult> {
    const record = this.payments.get(providerPaymentId);
    if (!record) throw new ValidationError("Unknown payment reference.");
    return this.toRetrieveResult(providerPaymentId, record);
  }

  /** See `PaymentProvider.retrievePaymentByIdempotencyKey`'s own doc comment. */
  async retrievePaymentByIdempotencyKey(idempotencyKey: string): Promise<RetrievePaymentResult | null> {
    const providerPaymentId = this.byIdempotencyKey.get(idempotencyKey);
    if (!providerPaymentId) return null;
    const record = this.payments.get(providerPaymentId);
    if (!record) return null;
    return this.toRetrieveResult(providerPaymentId, record);
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
    // PACKAGE B — remaining Codex blockers (Section 4 — reconciliation evidence must be complete):
    // this sandbox provider's own explicit contract is "there is no fee simulation" — normalized
    // HERE, at the seam between an untrusted raw webhook body and the internal `data` this codebase
    // trusts, so every consumer (the original webhook-processing path AND reconciliation's automatic
    // repair evidence check) sees the SAME explicit zero, never an implicitly-absent field that
    // generic reconciliation code would otherwise have to guess about.
    const data: Record<string, unknown> = { ...parsed };
    if (parsed.eventType === "payment.succeeded") {
      if (typeof data.processorFeeMinorUnits !== "number") data.processorFeeMinorUnits = 0;
      if (typeof data.platformFeeMinorUnits !== "number") data.platformFeeMinorUnits = 0;
    }
    return {
      provider: this.providerName,
      providerEventId: parsed.providerEventId,
      eventType: parsed.eventType,
      data,
    };
  }

  /** Test/sandbox-simulator helper — produces a signature a real caller would send in the webhook's signature header. */
  signWebhookPayload(rawBody: string): string {
    return computeHmacSignature(rawBody, this.webhookSecret);
  }
}
