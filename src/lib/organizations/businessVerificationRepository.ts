import "server-only";
import type { BusinessVerificationResultStatus } from "./businessVerificationProvider";

export interface BusinessVerificationRecord {
  id: string;
  organizationId: string;
  provider: string;
  providerReference: string | null;
  status: BusinessVerificationResultStatus | "not_submitted";
  submittedAt: Date | null;
  verifiedAt: Date | null;
  legalNameResult: string | null;
  taxIdResult: string | null;
  addressResult: string | null;
  representativeResult: string | null;
  failureCode: string | null;
  reviewRequired: boolean;
  taxIdLast4: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Real implementation: DrizzleBusinessVerificationRepository. */
export interface BusinessVerificationRepository {
  /** DB-12: raw EIN never appears here — only safe metadata (see businessVerificationService.ts's own doc comment). */
  insertSubmission(input: {
    organizationId: string;
    provider: string;
    providerReference: string;
    taxIdLast4: string;
  }): Promise<BusinessVerificationRecord>;
  /** Tenant-scoped by construction. */
  findLatestForOrganization(organizationId: string): Promise<BusinessVerificationRecord | null>;
  findByProviderReference(providerReference: string): Promise<BusinessVerificationRecord | null>;
  applyResult(
    id: string,
    input: {
      status: BusinessVerificationResultStatus;
      legalNameResult: string | null;
      taxIdResult: string | null;
      addressResult: string | null;
      representativeResult: string | null;
      failureCode: string | null;
      reviewRequired: boolean;
      verifiedAt: Date | null;
    },
  ): Promise<void>;
}
