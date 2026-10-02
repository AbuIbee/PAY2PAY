import "server-only";

export type BusinessObligationStatus = "open" | "paid" | "written_off";

export interface BusinessObligationRecord {
  id: string;
  businessProfileId: string;
  customerId: string;
  agreementId: string | null;
  externalReference: string | null;
  invoiceReference: string | null;
  originalAmountMinorUnits: number;
  agreedAmountMinorUnits: number;
  status: BusinessObligationStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 2 (2026-10-02),
 * Phase 7: same tenant-scoped-by-construction contract as BusinessCustomerRepository — no bare
 * `findById(obligationId)`. See that interface's own doc comment for the full rationale.
 */
export interface BusinessObligationRepository {
  insert(input: {
    businessProfileId: string;
    customerId: string;
    agreementId?: string | null;
    externalReference?: string | null;
    invoiceReference?: string | null;
    originalAmountMinorUnits: number;
    agreedAmountMinorUnits: number;
  }): Promise<BusinessObligationRecord>;
  findByIdForOrganization(organizationId: string, obligationId: string): Promise<BusinessObligationRecord | null>;
  listForOrganization(organizationId: string): Promise<BusinessObligationRecord[]>;
  listForCustomer(organizationId: string, customerId: string): Promise<BusinessObligationRecord[]>;
}
