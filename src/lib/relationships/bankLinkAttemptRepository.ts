import type { ProfileKind } from "@/lib/payments/paymentProvider";

export type BankLinkAttemptStatus = "pending" | "authorised" | "completed" | "failed" | "expired";

export interface BankLinkAttemptRecord {
  id: string;
  providerSessionId: string;
  merchantReference: string;
  actingUserId: string;
  partyProfileKind: ProfileKind;
  partyIndividualProfileId: string | null;
  partyOrganizationId: string | null;
  shopperReference: string;
  institutionDisplayName: string | null;
  confirmedPspReference: string | null;
  status: BankLinkAttemptStatus;
  resultFinancialAccountId: string | null;
  createdAt: Date;
  expiresAt: Date;
  confirmedAt: Date | null;
  completedAt: Date | null;
}

/**
 * PAID2YOU — B0-D ADYEN PHASE 2A. See `src/db/schema/bankLinkAttempt.ts`'s own doc comment for the
 * full webhook-only correlation chain this repository's rows durably track — this repository owns
 * only that one table. Real implementation: `DrizzleBankLinkAttemptRepository`.
 */
export interface BankLinkAttemptRepository {
  insert(input: {
    providerSessionId: string;
    merchantReference: string;
    actingUserId: string;
    partyProfileKind: ProfileKind;
    partyIndividualProfileId: string | null;
    partyOrganizationId: string | null;
    shopperReference: string;
    institutionDisplayName: string | null;
    expiresAt: Date;
  }): Promise<BankLinkAttemptRecord>;
  findByProviderSessionId(providerSessionId: string): Promise<BankLinkAttemptRecord | null>;
  /** The AUTHORISATION webhook's own `merchantReference` is the only lookup key available at that stage — see the schema's own doc comment, step 2. */
  findByMerchantReference(merchantReference: string): Promise<BankLinkAttemptRecord | null>;
  /** The token-lifecycle webhook's own `eventId` (pspReference) is the only lookup key available at that stage — see the schema's own doc comment, step 3. */
  findByConfirmedPspReference(pspReference: string): Promise<BankLinkAttemptRecord | null>;
  /** `pending` -> `authorised` (success:true) or `pending` -> `failed` (success:false), keyed by the row's own id to avoid a second unscoped lookup after the caller already resolved it. Idempotent: a redelivered AUTHORISATION for an already-`authorised`/`completed` row is a caller-level no-op — see BankConnectionService's own doc comment. */
  markAuthorised(id: string, confirmedPspReference: string, confirmedAt: Date): Promise<BankLinkAttemptRecord>;
  markCompleted(id: string, resultFinancialAccountId: string, completedAt: Date): Promise<BankLinkAttemptRecord>;
  markFailed(id: string): Promise<BankLinkAttemptRecord>;
}
