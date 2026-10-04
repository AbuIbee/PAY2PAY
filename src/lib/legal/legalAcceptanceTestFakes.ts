import { randomUUID } from "node:crypto";
import type { LegalAcceptanceRecord, LegalAcceptanceRepository } from "./legalAcceptanceRepository";
import { LegalAcceptanceService } from "./legalAcceptanceService";

/** Test-only in-memory double, mirroring this codebase's per-domain testFakes.ts pattern. */
export class InMemoryLegalAcceptanceRepository implements LegalAcceptanceRepository {
  rows: LegalAcceptanceRecord[] = [];

  async insert(input: {
    userId: string;
    organizationId: string | null;
    documentType: string;
    documentVersion: string;
    acceptedAt: Date;
    metadata: Record<string, unknown> | null;
  }): Promise<LegalAcceptanceRecord> {
    const record: LegalAcceptanceRecord = { id: randomUUID(), ...input };
    this.rows.push(record);
    return record;
  }

  async findCurrent(input: { userId: string; organizationId: string | null; documentType: string; documentVersion: string }): Promise<LegalAcceptanceRecord | null> {
    return (
      this.rows.find(
        (r) => r.userId === input.userId && r.organizationId === input.organizationId && r.documentType === input.documentType && r.documentVersion === input.documentVersion,
      ) ?? null
    );
  }

  async findCurrentForOrganization(input: { organizationId: string; documentType: string; documentVersion: string }): Promise<LegalAcceptanceRecord | null> {
    return this.rows.find((r) => r.organizationId === input.organizationId && r.documentType === input.documentType && r.documentVersion === input.documentVersion) ?? null;
  }

  async listForOrganization(organizationId: string): Promise<LegalAcceptanceRecord[]> {
    return this.rows.filter((r) => r.organizationId === organizationId);
  }
}

export function createTestLegalAcceptanceService() {
  const repo = new InMemoryLegalAcceptanceRepository();
  const legalAcceptanceService = new LegalAcceptanceService(repo);
  return { legalAcceptanceService, repo };
}
