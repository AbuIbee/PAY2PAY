import "server-only";
import type { PaymentMethod } from "./paymentService";

/**
 * PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 2 — CENTRALIZE PAID2YOU
 * PLATFORM-FEE AUTHORITY). Everything a real future fee assessment could plausibly need — the
 * settled amount, currency, which rail the payment used, and which agreement it belongs to — without
 * requiring a full, hydrated `PaymentAttemptRecord` at every call site (some callers, e.g.
 * `FailedPaymentRetryCoordinator.resolveAmbiguousRetry`, only ever hold a raw `payment_attempt` row
 * read inside a transaction, not the mapped record type).
 */
export interface PlatformFeeContext {
  amountMinorUnits: number;
  currency: string;
  paymentMethod: PaymentMethod | null;
  agreementId: string | null;
}

/**
 * The SINGLE, centralized Paid2You authority for `platformFeeMinorUnits` on a provider-routed
 * payment. Every consumer — the normal webhook-receipt ledger posting AND the ambiguous
 * provider-outcome reconstruction path — MUST obtain this value from here, never from a locally
 * duplicated constant and never from any external provider/webhook payload (Paid2You's own platform
 * fee is never the external provider's to define or report). A future monetization change is a
 * ONE-LINE change to this single policy's own implementation, not a hunt across every payment path
 * for a hardcoded zero.
 */
export interface PlatformFeePolicy {
  getPlatformFeeMinorUnits(context: PlatformFeeContext): Promise<number>;
}

/**
 * Today's actual authoritative Paid2You policy: always zero. This codebase has no live
 * provider-routed platform-fee assessment integrated yet (a documented, pre-existing scope
 * limitation predating this fix, matching `SandboxPaymentProvider`'s own "no fee simulation" baseline
 * for the processor side) — this is that explicit business rule's one canonical home, not an
 * incidental default. When real platform-fee monetization is implemented, only this class changes.
 *
 * PAID2YOU — PACKAGE B (Stage 6 final architecture closure, Item 2): the fee is currently FIXED and
 * non-configurable, which is exactly why it is safe to evaluate fresh at settlement time everywhere
 * it is needed rather than being established/persisted earlier, at payment creation/preparation — a
 * fixed policy can never disagree with itself between those two moments. BEFORE Paid2You introduces a
 * configurable or nonzero platform fee, this invariant must be re-examined: if the future business
 * rule requires the fee to be fixed at initiation (rather than freely re-evaluated at settlement —
 * e.g. a per-transaction rate that could change between when a payment is created and when it
 * eventually settles), the fee will need to become transaction-specific/durable (persisted on or
 * alongside the `payment_attempt` at creation time, and read back rather than re-derived at
 * settlement). That future pricing/monetization decision is explicitly OUTSIDE this Package B
 * remediation's scope — do not add such persistence now merely for hypothetical future convenience.
 */
export class DefaultPlatformFeePolicy implements PlatformFeePolicy {
  async getPlatformFeeMinorUnits(_context: PlatformFeeContext): Promise<number> {
    return 0;
  }
}
