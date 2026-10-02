import "server-only";

export type BusinessCustomerStatus = "active" | "archived";
export type CounterpartyProfileKind = "personal" | "business";

export interface BusinessCustomerRecord {
  id: string;
  businessProfileId: string;
  counterpartyProfileKind: CounterpartyProfileKind;
  counterpartyProfileId: string;
  externalCustomerReference: string | null;
  status: BusinessCustomerStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 2 (2026-10-02),
 * Phase 7: every read is tenant-scoped BY CONSTRUCTION — there is deliberately no
 * `findById(customerId)` method on this interface. A valid business_customer id belonging to a
 * different organization is indistinguishable from a nonexistent one to every caller (null, not an
 * error that would leak existence across tenants). Callers are still responsible for independently
 * verifying the caller's own membership in `organizationId` via OrganizationAuthorizationService
 * before calling this — tenant-scoping the query is a second, independent layer of defense, never a
 * substitute for the membership/capability check.
 */
export interface BusinessCustomerRepository {
  insert(input: {
    businessProfileId: string;
    counterpartyProfileKind: CounterpartyProfileKind;
    counterpartyProfileId: string;
    externalCustomerReference?: string | null;
  }): Promise<BusinessCustomerRecord>;
  findByIdForOrganization(organizationId: string, customerId: string): Promise<BusinessCustomerRecord | null>;
  listForOrganization(organizationId: string): Promise<BusinessCustomerRecord[]>;
}
