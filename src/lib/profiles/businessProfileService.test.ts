import { beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { createTestBusinessProfileService } from "./testFakes";

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";

describe("BusinessProfileService", () => {
  let ctx: ReturnType<typeof createTestBusinessProfileService>;

  beforeEach(() => {
    ctx = createTestBusinessProfileService();
  });

  const validInput = (overrides: Partial<Parameters<typeof ctx.businessProfileService.createBusinessProfile>[0]> = {}) => ({
    ownerUserId: OWNER_A,
    legalBusinessName: "Acme Repair LLC",
    displayName: "Acme Repair",
    entityType: "llc",
    businessAddress: { line1: "123 Main St", city: "Springfield", state: "IL", postalCode: "62701" },
    country: "US",
    state: "IL",
    ...overrides,
  });

  it("creates a business profile with the required fields", async () => {
    const profile = await ctx.businessProfileService.createBusinessProfile(validInput());
    expect(profile.legalBusinessName).toBe("Acme Repair LLC");
    expect(profile.displayName).toBe("Acme Repair");
    expect(profile.status).toBe("active");
  });

  it("audits business profile creation", async () => {
    await ctx.businessProfileService.createBusinessProfile(validInput());
    expect(ctx.auditRepo.events.map((e) => e.action)).toEqual(["business_profile_created"]);
  });

  it("rejects a missing legal business name", async () => {
    await expect(
      ctx.businessProfileService.createBusinessProfile(validInput({ legalBusinessName: "" })),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a missing state", async () => {
    await expect(ctx.businessProfileService.createBusinessProfile(validInput({ state: "" }))).rejects.toThrow(
      ValidationError,
    );
  });

  it("allows multiple owned businesses for the same user", async () => {
    await ctx.businessProfileService.createBusinessProfile(validInput({ legalBusinessName: "First LLC" }));
    await ctx.businessProfileService.createBusinessProfile(validInput({ legalBusinessName: "Second LLC" }));
    const list = await ctx.businessProfileService.listMyBusinessProfiles(OWNER_A);
    expect(list).toHaveLength(2);
  });

  it("cross-user isolation: an owner cannot fetch another user's business profile", async () => {
    const profile = await ctx.businessProfileService.createBusinessProfile(validInput({ ownerUserId: OWNER_A }));
    const asOwner = await ctx.businessProfileService.getOwnedBusinessProfile(OWNER_A, profile.id);
    const asOther = await ctx.businessProfileService.getOwnedBusinessProfile(OWNER_B, profile.id);
    expect(asOwner?.id).toBe(profile.id);
    expect(asOther).toBeNull();
  });

  it("cross-user isolation: listing only returns the caller's own businesses", async () => {
    await ctx.businessProfileService.createBusinessProfile(validInput({ ownerUserId: OWNER_A }));
    await ctx.businessProfileService.createBusinessProfile(
      validInput({ ownerUserId: OWNER_B, legalBusinessName: "Other Co" }),
    );
    const listA = await ctx.businessProfileService.listMyBusinessProfiles(OWNER_A);
    const listB = await ctx.businessProfileService.listMyBusinessProfiles(OWNER_B);
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0]?.ownerUserId).toBe(OWNER_A);
    expect(listB[0]?.ownerUserId).toBe(OWNER_B);
  });
});
