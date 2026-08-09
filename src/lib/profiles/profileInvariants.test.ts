import { describe, expect, it } from "vitest";
import { ConflictError } from "@/lib/errors";
import { InMemoryPersonalProfileRepository } from "@/lib/auth/testFakes";
import { createTestBusinessProfileService, createTestProfileAccessService } from "./testFakes";

/**
 * Sprint 3 (docs/sprints/SPRINT_03_Personal_Business_Profiles.md) required
 * tests not already covered as a side effect of another test file:
 * "one personal profile maximum" and "cross-business isolation."
 */
describe("Sprint 3 profile invariants", () => {
  it("one personal profile maximum: a second insert for the same user is rejected", async () => {
    const repo = new InMemoryPersonalProfileRepository();
    await repo.insert("user-1");
    await expect(repo.insert("user-1")).rejects.toThrow(ConflictError);
  });

  it("cross-business isolation: selecting business A never returns business B's identity, even for the same owner", async () => {
    const ctx = createTestProfileAccessService();
    const businessA = await ctx.businessProfiles.insert({
      ownerUserId: "owner-1",
      legalBusinessName: "A LLC",
      displayName: "Business A",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
    const businessB = await ctx.businessProfiles.insert({
      ownerUserId: "owner-1",
      legalBusinessName: "B LLC",
      displayName: "Business B",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "NY",
    });

    const resolvedA = await ctx.profileAccessService.resolveActiveProfile("owner-1", {
      kind: "business",
      businessProfileId: businessA.id,
    });
    expect(resolvedA.businessProfileId).toBe(businessA.id);
    expect(resolvedA.displayName).toBe("Business A");
    expect(resolvedA.businessProfileId).not.toBe(businessB.id);

    const resolvedB = await ctx.profileAccessService.resolveActiveProfile("owner-1", {
      kind: "business",
      businessProfileId: businessB.id,
    });
    expect(resolvedB.businessProfileId).toBe(businessB.id);
    expect(resolvedB.displayName).toBe("Business B");
  });

  it("cross-business isolation: getOwnedBusinessProfile for A does not return B's fields even for the same owner", async () => {
    const ctx = createTestBusinessProfileService();
    const businessA = await ctx.businessProfileService.createBusinessProfile({
      ownerUserId: "owner-1",
      legalBusinessName: "A LLC",
      displayName: "Business A",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
    await ctx.businessProfileService.createBusinessProfile({
      ownerUserId: "owner-1",
      legalBusinessName: "B LLC",
      displayName: "Business B",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "NY",
    });

    const fetched = await ctx.businessProfileService.getOwnedBusinessProfile("owner-1", businessA.id);
    expect(fetched?.displayName).toBe("Business A");
    expect(fetched?.legalBusinessName).toBe("A LLC");
  });
});
