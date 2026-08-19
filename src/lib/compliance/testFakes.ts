import { randomUUID } from "node:crypto";
import { ConsentService, type ConsentPolicyType, type ConsentRecord, type ConsentRepository } from "./consentService";
import { DataExportService, type UserAccountReader } from "./dataExportService";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import { ProfileAccessService } from "@/lib/profiles/profileAccessService";
import { InMemoryPersonalProfileRepository } from "@/lib/auth/testFakes";
import { InMemoryBusinessProfileRepository } from "@/lib/profiles/testFakes";

export class InMemoryConsentRepository implements ConsentRepository {
  private byId = new Map<string, ConsentRecord>();

  async insert(input: { userId: string; policyType: ConsentPolicyType; policyVersion: string; method: string; ipAddress: string | null }): Promise<ConsentRecord> {
    const record: ConsentRecord = { id: randomUUID(), consentedAt: new Date(), ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async listForUser(userId: string): Promise<ConsentRecord[]> {
    return [...this.byId.values()].filter((c) => c.userId === userId).sort((a, b) => b.consentedAt.getTime() - a.consentedAt.getTime());
  }
}

export function createTestConsentService() {
  const consents = new InMemoryConsentRepository();
  const consentService = new ConsentService({ consents });
  return { consentService, consents };
}

export class InMemoryUserAccountReader implements UserAccountReader {
  emails = new Map<string, string>();

  async getEmailByUserId(userId: string): Promise<string | null> {
    return this.emails.get(userId) ?? null;
  }
}

export function createTestDataExportService() {
  const personalProfiles = new InMemoryPersonalProfileRepository();
  const businessProfiles = new InMemoryBusinessProfileRepository();
  const profileAccess = new ProfileAccessService(personalProfiles, businessProfiles);
  const agreementCtx = createTestAgreementService();
  const { consentService, consents } = createTestConsentService();
  const accounts = new InMemoryUserAccountReader();

  const dataExportService = new DataExportService({
    profileAccess,
    agreements: agreementCtx.agreementService,
    consents: consentService,
    accounts,
  });

  return { dataExportService, personalProfiles, businessProfiles, profileAccess, agreementCtx, consentService, consents, accounts };
}
