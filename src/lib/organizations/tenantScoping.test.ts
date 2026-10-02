import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestBusinessReceivablesRepositories } from "./testFakes";

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 2 (2026-10-02),
 * Phase 7: proves the tenant-scoped-by-construction repository contract — a valid resource id from
 * Organization A is never reachable through Organization B's scope, regardless of membership.
 * These repositories have no bare `findById(id)` method at all (see businessCustomerRepository.ts
 * and businessObligationRepository.ts's own doc comments) — this test exercises the only methods
 * that exist, proving the shape itself closes the IDOR, not merely a check inside one method.
 */
describe("tenant-scoped repository contract (businessCustomer / businessObligation)", () => {
  let repos: ReturnType<typeof createTestBusinessReceivablesRepositories>;
  const ORG_A = randomUUID();
  const ORG_B = randomUUID();

  beforeEach(() => {
    repos = createTestBusinessReceivablesRepositories();
  });

  it("business_customer: an Org A resource id is NOT FOUND when looked up under Org B's scope", async () => {
    const customer = await repos.customers.insert({
      businessProfileId: ORG_A,
      counterpartyProfileKind: "personal",
      counterpartyProfileId: randomUUID(),
    });

    expect(await repos.customers.findByIdForOrganization(ORG_A, customer.id)).not.toBeNull();
    expect(await repos.customers.findByIdForOrganization(ORG_B, customer.id)).toBeNull();
  });

  it("business_customer: listForOrganization never returns another organization's rows", async () => {
    await repos.customers.insert({ businessProfileId: ORG_A, counterpartyProfileKind: "personal", counterpartyProfileId: randomUUID() });
    await repos.customers.insert({ businessProfileId: ORG_B, counterpartyProfileKind: "personal", counterpartyProfileId: randomUUID() });

    const listA = await repos.customers.listForOrganization(ORG_A);
    const listB = await repos.customers.listForOrganization(ORG_B);
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0]?.businessProfileId).toBe(ORG_A);
    expect(listB[0]?.businessProfileId).toBe(ORG_B);
  });

  it("business_obligation: an Org A resource id is NOT FOUND when looked up under Org B's scope", async () => {
    const customer = await repos.customers.insert({ businessProfileId: ORG_A, counterpartyProfileKind: "personal", counterpartyProfileId: randomUUID() });
    const obligation = await repos.obligations.insert({
      businessProfileId: ORG_A,
      customerId: customer.id,
      originalAmountMinorUnits: 10_000,
      agreedAmountMinorUnits: 10_000,
    });

    expect(await repos.obligations.findByIdForOrganization(ORG_A, obligation.id)).not.toBeNull();
    expect(await repos.obligations.findByIdForOrganization(ORG_B, obligation.id)).toBeNull();
  });

  it("business_obligation: listForOrganization and listForCustomer never cross tenants", async () => {
    const customerA = await repos.customers.insert({ businessProfileId: ORG_A, counterpartyProfileKind: "personal", counterpartyProfileId: randomUUID() });
    const customerB = await repos.customers.insert({ businessProfileId: ORG_B, counterpartyProfileKind: "personal", counterpartyProfileId: randomUUID() });
    await repos.obligations.insert({ businessProfileId: ORG_A, customerId: customerA.id, originalAmountMinorUnits: 5_000, agreedAmountMinorUnits: 5_000 });
    await repos.obligations.insert({ businessProfileId: ORG_B, customerId: customerB.id, originalAmountMinorUnits: 5_000, agreedAmountMinorUnits: 5_000 });

    expect(await repos.obligations.listForOrganization(ORG_A)).toHaveLength(1);
    expect(await repos.obligations.listForOrganization(ORG_B)).toHaveLength(1);
    // Org B's scope + Org A's customer id: no obligations leak across the boundary either way.
    expect(await repos.obligations.listForCustomer(ORG_B, customerA.id)).toHaveLength(0);
  });
});
