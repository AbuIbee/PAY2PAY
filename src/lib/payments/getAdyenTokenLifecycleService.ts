import "server-only";
import { getAchMandateService } from "@/lib/ach/getAchMandateService";
import { getBankConnectionService } from "@/lib/relationships/getBankConnectionService";
import { getRelationshipFinancialAccountService } from "@/lib/relationships/getRelationshipFinancialAccountService";
import { getPaymentProvider } from "./getPaymentProvider";
import { AdyenTokenLifecycleService } from "./adyenTokenLifecycleService";

let cached: AdyenTokenLifecycleService | null = null;

/**
 * Lazily creates (and memoizes) the production AdyenTokenLifecycleService.
 *
 * PAID2YOU — B0-D ADYEN PHASE 2A: deliberately reuses `getBankConnectionService()`'s own construction
 * (including its `ADYEN_ACH_TOKENIZATION_VERIFIED` EXTERNAL BLOCKER gate — see that factory's own doc
 * comment). While bank-linking is gated off, no `bank_link_attempt` can ever reach "authorised", so
 * there is nothing for `recurring.token.created`/`alreadyExisting` to correlate against regardless;
 * this webhook consumer (including `recurring.token.disabled` reconciliation) staying unavailable
 * during that state is an accepted, easily-diagnosed operational tradeoff (Adyen redelivers), never a
 * security concern.
 */
export function getAdyenTokenLifecycleService(): AdyenTokenLifecycleService {
  if (!cached) {
    cached = new AdyenTokenLifecycleService({
      bankConnections: getBankConnectionService(),
      financialAccounts: getRelationshipFinancialAccountService(),
      achMandates: getAchMandateService(),
      providerName: getPaymentProvider().providerName,
    });
  }
  return cached;
}
