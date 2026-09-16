import "server-only";
import { getAchMandateService } from "@/lib/ach/getAchMandateService";
import type { AchMandateProviderRefReader } from "./paymentService";

/**
 * PAID2YOU — B0-D ADYEN PHASE 1A (blocker 1 — exact payment method): production implementation of
 * `AchMandateProviderRefReader` — reuses `AchMandateService.getActiveMandate` (the SAME read every
 * ACH route already goes through), never a second, parallel mandate lookup. Returns the active
 * mandate's own `bankAccountRef` — the exact opaque provider bank-account reference captured at
 * authorization time (`BankConnectionService`/`AchMandateService`'s existing "Sprint 11 has no
 * concept of financial_account_id, bankAccountRef is the provider's own token" convention) — never
 * derived, guessed, or looked up via a shopper directory. Shared by `getPaymentService.ts` (the
 * original-submission path) and `getFailedPaymentRetryCoordinator.ts` (the ambiguity-resolution/
 * re-dispatch path) so both always resolve the identical reference for the identical agreement.
 */
export class DrizzleAchMandateProviderRefReader implements AchMandateProviderRefReader {
  async getActiveProviderRef(agreementId: string): Promise<string | null> {
    const mandate = await getAchMandateService().getActiveMandate(agreementId);
    return mandate?.bankAccountRef ?? null;
  }
}
