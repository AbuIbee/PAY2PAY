import "server-only";
import { randomUUID } from "node:crypto";
import type { BusinessVerificationResultStatus } from "./businessVerificationProvider";
import type { BusinessVerificationRecord, BusinessVerificationRepository } from "./businessVerificationRepository";

export class InMemoryBusinessVerificationRepository implements BusinessVerificationRepository {
  private byId = new Map<string, BusinessVerificationRecord>();

  async insertSubmission(input: { organizationId: string; provider: string; providerReference: string; taxIdLast4: string }): Promise<BusinessVerificationRecord> {
    const record: BusinessVerificationRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      provider: input.provider,
      providerReference: input.providerReference,
      status: "pending",
      submittedAt: new Date(),
      verifiedAt: null,
      legalNameResult: null,
      taxIdResult: null,
      addressResult: null,
      representativeResult: null,
      failureCode: null,
      reviewRequired: false,
      taxIdLast4: input.taxIdLast4,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findLatestForOrganization(organizationId: string): Promise<BusinessVerificationRecord | null> {
    const matches = [...this.byId.values()].filter((r) => r.organizationId === organizationId);
    matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return matches[0] ?? null;
  }

  async findByProviderReference(providerReference: string): Promise<BusinessVerificationRecord | null> {
    return [...this.byId.values()].find((r) => r.providerReference === providerReference) ?? null;
  }

  async applyResult(
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
  ): Promise<void> {
    const record = this.byId.get(id);
    if (record) Object.assign(record, input, { updatedAt: new Date() });
  }
}
