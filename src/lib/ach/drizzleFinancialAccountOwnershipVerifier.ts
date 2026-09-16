import "server-only";
import { getPaymentProvider } from "@/lib/payments/getPaymentProvider";
import { DrizzleFinancialAccountRepository } from "@/lib/relationships/drizzleFinancialAccountRepository";
import type { ProfileRef } from "@/lib/payments/paymentProvider";
import type { FinancialAccountOwnershipVerifier } from "./achMandateService";

/**
 * PAID2YOU — B0-D ADYEN PHASE 2: production implementation of `FinancialAccountOwnershipVerifier` —
 * reuses `DrizzleFinancialAccountRepository.findByProviderRef` (the SAME lookup the token-lifecycle
 * webhook handler uses — see that repository's own doc comment), never a second, parallel query
 * against `financial_account`. Scoped to the currently-active payment provider's own name
 * (`getPaymentProvider().providerName`) rather than a hardcoded "adyen" literal, so this never drifts
 * from whichever provider actually tokenized the account. Requires the account be
 * `status === "verified"` — a `pending_verification`/`failed`/`disabled` account is never eligible to
 * back a new mandate.
 */
export class DrizzleFinancialAccountOwnershipVerifier implements FinancialAccountOwnershipVerifier {
  private readonly repo = new DrizzleFinancialAccountRepository();

  async isVerifiedAccountOwnedByProfile(providerAccountRef: string, profile: ProfileRef): Promise<boolean> {
    const account = await this.repo.findByProviderRef(getPaymentProvider().providerName, providerAccountRef);
    if (!account || account.status !== "verified") return false;
    if (profile.profileKind === "personal") return account.individualProfileId === profile.profileId;
    return account.organizationId === profile.profileId;
  }
}
