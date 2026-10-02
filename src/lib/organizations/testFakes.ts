import { randomUUID } from "node:crypto";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import { InMemoryBusinessProfileRepository } from "@/lib/profiles/testFakes";
import { createTestPricingServiceWithEntitlements } from "@/lib/pricing/testFakes";
import { createTestStaffService } from "@/lib/staff/testFakes";
import { AgreementWorkspaceService } from "./agreementWorkspaceService";
import type { BusinessCustomerRecord, BusinessCustomerRepository, CounterpartyProfileKind } from "./businessCustomerRepository";
import type { BusinessObligationRecord, BusinessObligationRepository } from "./businessObligationRepository";
import { EntitlementService } from "./entitlementService";
import { OrganizationAuthorizationService } from "./organizationAuthorizationService";
import { WorkspaceContextService } from "./workspaceContext";

/** Test-only in-memory wiring, mirroring the rest of this codebase's per-domain testFakes.ts pattern. */

export function createTestOrganizationAuthorizationService() {
  const businessProfiles = new InMemoryBusinessProfileRepository();
  const staffCtx = createTestStaffService();
  const orgAuth = new OrganizationAuthorizationService(businessProfiles, staffCtx.staffMembers, staffCtx.staffService);
  return { orgAuth, businessProfiles, ...staffCtx };
}

export function createTestWorkspaceContextService() {
  const authCtx = createTestOrganizationAuthorizationService();
  const workspaceContext = new WorkspaceContextService(authCtx.orgAuth);
  return { workspaceContext, ...authCtx };
}

export function createTestEntitlementService() {
  const { pricingService, plans, subscriptions, entitlements } = createTestPricingServiceWithEntitlements();
  const entitlementService = new EntitlementService(pricingService, entitlements);
  return { entitlementService, plans, subscriptions, entitlements };
}

/** Tenant-scoped-by-construction in-memory doubles — see businessCustomerRepository.ts's own doc comment. */
export class InMemoryBusinessCustomerRepository implements BusinessCustomerRepository {
  private byId = new Map<string, BusinessCustomerRecord>();

  async insert(input: {
    businessProfileId: string;
    counterpartyProfileKind: CounterpartyProfileKind;
    counterpartyProfileId: string;
    externalCustomerReference?: string | null;
  }): Promise<BusinessCustomerRecord> {
    const record: BusinessCustomerRecord = {
      id: randomUUID(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      externalCustomerReference: null,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findByIdForOrganization(organizationId: string, customerId: string): Promise<BusinessCustomerRecord | null> {
    const record = this.byId.get(customerId);
    if (!record || record.businessProfileId !== organizationId) return null;
    return record;
  }

  async listForOrganization(organizationId: string): Promise<BusinessCustomerRecord[]> {
    return [...this.byId.values()].filter((r) => r.businessProfileId === organizationId);
  }
}

export class InMemoryBusinessObligationRepository implements BusinessObligationRepository {
  private byId = new Map<string, BusinessObligationRecord>();

  async insert(input: {
    businessProfileId: string;
    customerId: string;
    agreementId?: string | null;
    externalReference?: string | null;
    invoiceReference?: string | null;
    originalAmountMinorUnits: number;
    agreedAmountMinorUnits: number;
  }): Promise<BusinessObligationRecord> {
    const record: BusinessObligationRecord = {
      id: randomUUID(),
      status: "open",
      createdAt: new Date(),
      updatedAt: new Date(),
      agreementId: null,
      externalReference: null,
      invoiceReference: null,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findByIdForOrganization(organizationId: string, obligationId: string): Promise<BusinessObligationRecord | null> {
    const record = this.byId.get(obligationId);
    if (!record || record.businessProfileId !== organizationId) return null;
    return record;
  }

  async listForOrganization(organizationId: string): Promise<BusinessObligationRecord[]> {
    return [...this.byId.values()].filter((r) => r.businessProfileId === organizationId);
  }

  async listForCustomer(organizationId: string, customerId: string): Promise<BusinessObligationRecord[]> {
    return [...this.byId.values()].filter((r) => r.businessProfileId === organizationId && r.customerId === customerId);
  }
}

export function createTestBusinessReceivablesRepositories() {
  const customers = new InMemoryBusinessCustomerRepository();
  const obligations = new InMemoryBusinessObligationRepository();
  return { customers, obligations };
}

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 8 (2026-10-02). The
 * agreement side (`agreementService`/`agreements` repo/`agreementStaffCtx`) and the organization
 * side (`orgAuth`/`businessProfiles`/`orgStaffMembers`) are deliberately separate StaffService
 * instances/repositories — AgreementService's own party-authorization (is this user allowed to act
 * for the creditor/debtor party) and OrganizationAuthorizationService's workspace-membership
 * question are independent concerns in production too (different StaffService call sites), so
 * these tests exercise that same separation rather than an artificially shared fake.
 */
export function createTestAgreementWorkspaceService() {
  const agreementCtx = createTestAgreementService();
  const orgAuthCtx = createTestOrganizationAuthorizationService();
  const entitlementCtx = createTestEntitlementService();
  const agreementWorkspaceService = new AgreementWorkspaceService(agreementCtx.agreementService, orgAuthCtx.orgAuth, entitlementCtx.entitlementService);
  return { agreementWorkspaceService, agreementCtx, orgAuthCtx, entitlementCtx };
}
