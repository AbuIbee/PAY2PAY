import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { businessProfile } from "@/db/schema";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { DrizzleLegalAcceptanceRepository } from "./drizzleLegalAcceptanceRepository";

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 24: real-Postgres proof for the
 * repository backing `LegalAcceptanceService` — real FKs (userId -> user_account, organizationId ->
 * business_profile), real tenant-scoped queries, never provable against in-memory fakes alone.
 */
async function seedOrganization(): Promise<string> {
  const db = getDb();
  const owner = await seedPersonalUser("legal-acceptance-org-owner");
  const [org] = await db
    .insert(businessProfile)
    .values({
      ownerUserId: owner.userId,
      legalBusinessName: `Legal Acceptance Test LLC ${randomUUID()}`,
      displayName: "Legal Acceptance Test",
      entityType: "llc",
      businessAddress: {},
      country: "US",
      state: "IL",
    })
    .returning({ id: businessProfile.id });
  if (!org) throw new Error("seedOrganization: business_profile insert returned no row");
  return org.id;
}

describe("DrizzleLegalAcceptanceRepository (real Postgres)", () => {
  it("records and reads back an organization-scoped acceptance", async () => {
    const repo = new DrizzleLegalAcceptanceRepository();
    const organizationId = await seedOrganization();
    const owner = await seedPersonalUser("legal-acceptance-member");

    const inserted = await repo.insert({ userId: owner.userId, organizationId, documentType: "terms", documentVersion: "2026-10-03", acceptedAt: new Date(), metadata: { ip: "127.0.0.1" } });
    expect(inserted.id).toBeTruthy();

    const current = await repo.findCurrentForOrganization({ organizationId, documentType: "terms", documentVersion: "2026-10-03" });
    expect(current?.id).toBe(inserted.id);

    const olderVersion = await repo.findCurrentForOrganization({ organizationId, documentType: "terms", documentVersion: "2020-01-01" });
    expect(olderVersion).toBeNull();
  });

  it("cross-organization isolation: one organization's acceptance never satisfies another's lookup", async () => {
    const repo = new DrizzleLegalAcceptanceRepository();
    const orgA = await seedOrganization();
    const orgB = await seedOrganization();
    const owner = await seedPersonalUser("legal-acceptance-cross-tenant");

    await repo.insert({ userId: owner.userId, organizationId: orgA, documentType: "business_subscription_policy", documentVersion: "2026-10-03", acceptedAt: new Date(), metadata: null });

    expect(await repo.findCurrentForOrganization({ organizationId: orgB, documentType: "business_subscription_policy", documentVersion: "2026-10-03" })).toBeNull();
    expect(await repo.findCurrentForOrganization({ organizationId: orgA, documentType: "business_subscription_policy", documentVersion: "2026-10-03" })).not.toBeNull();
  });

  it("findCurrent is exact-match on user+scope+type+version, and listForOrganization returns every acceptance for that organization", async () => {
    const repo = new DrizzleLegalAcceptanceRepository();
    const organizationId = await seedOrganization();
    const owner = await seedPersonalUser("legal-acceptance-listing");

    await repo.insert({ userId: owner.userId, organizationId, documentType: "terms", documentVersion: "2026-10-03", acceptedAt: new Date(), metadata: null });
    await repo.insert({ userId: owner.userId, organizationId, documentType: "recurring_payment_authorization", documentVersion: "2026-10-03", acceptedAt: new Date(), metadata: null });

    const mine = await repo.findCurrent({ userId: owner.userId, organizationId, documentType: "terms", documentVersion: "2026-10-03" });
    expect(mine).not.toBeNull();
    const someoneElse = await repo.findCurrent({ userId: randomUUID(), organizationId, documentType: "terms", documentVersion: "2026-10-03" });
    expect(someoneElse).toBeNull();

    const all = await repo.listForOrganization(organizationId);
    expect(all).toHaveLength(2);
  });
});
