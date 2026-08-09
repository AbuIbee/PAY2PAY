import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestProfileAccessService } from "./testFakes";

const USER_A = "user-a";
const USER_B = "user-b";

describe("ProfileAccessService", () => {
  let ctx: ReturnType<typeof createTestProfileAccessService>;

  beforeEach(() => {
    ctx = createTestProfileAccessService();
  });

  it("resolves the caller's own personal profile", async () => {
    const personal = await ctx.personalProfiles.insert(USER_A);
    const resolved = await ctx.profileAccessService.resolveActiveProfile(USER_A, { kind: "personal" });
    expect(resolved.kind).toBe("personal");
    expect(resolved.personalProfileId).toBe(personal.id);
  });

  it("resolves an owned, active business profile", async () => {
    const business = await ctx.businessProfiles.insert({
      ownerUserId: USER_A,
      legalBusinessName: "Acme LLC",
      displayName: "Acme",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
    const resolved = await ctx.profileAccessService.resolveActiveProfile(USER_A, {
      kind: "business",
      businessProfileId: business.id,
    });
    expect(resolved.kind).toBe("business");
    expect(resolved.businessProfileId).toBe(business.id);
  });

  it("cross-user isolation: unauthorized profile switching is blocked", async () => {
    const business = await ctx.businessProfiles.insert({
      ownerUserId: USER_A,
      legalBusinessName: "Acme LLC",
      displayName: "Acme",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
    await expect(
      ctx.profileAccessService.resolveActiveProfile(USER_B, { kind: "business", businessProfileId: business.id }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("a disabled business cannot be selected", async () => {
    const business = await ctx.businessProfiles.insert({
      ownerUserId: USER_A,
      legalBusinessName: "Acme LLC",
      displayName: "Acme",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
    ctx.businessProfiles.setStatus(business.id, "disabled");
    await expect(
      ctx.profileAccessService.resolveActiveProfile(USER_A, { kind: "business", businessProfileId: business.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("a deleted business cannot be selected", async () => {
    const business = await ctx.businessProfiles.insert({
      ownerUserId: USER_A,
      legalBusinessName: "Acme LLC",
      displayName: "Acme",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
    ctx.businessProfiles.setStatus(business.id, "deleted");
    await expect(
      ctx.profileAccessService.resolveActiveProfile(USER_A, { kind: "business", businessProfileId: business.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("a nonexistent business profile id is rejected the same as an unauthorized one", async () => {
    await expect(
      ctx.profileAccessService.resolveActiveProfile(USER_A, {
        kind: "business",
        businessProfileId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("listSelectableProfiles never includes another user's businesses, and excludes disabled/deleted ones", async () => {
    await ctx.personalProfiles.insert(USER_A);
    const active = await ctx.businessProfiles.insert({
      ownerUserId: USER_A,
      legalBusinessName: "Active LLC",
      displayName: "Active Co",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
    const disabled = await ctx.businessProfiles.insert({
      ownerUserId: USER_A,
      legalBusinessName: "Disabled LLC",
      displayName: "Disabled Co",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
    ctx.businessProfiles.setStatus(disabled.id, "disabled");
    await ctx.businessProfiles.insert({
      ownerUserId: USER_B,
      legalBusinessName: "Other Owner LLC",
      displayName: "Other Owner Co",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });

    const list = await ctx.profileAccessService.listSelectableProfiles(USER_A);
    const businessIds = list.filter((p) => p.kind === "business").map((p) => p.businessProfileId);
    expect(businessIds).toEqual([active.id]);
    expect(businessIds).not.toContain(disabled.id);
  });

  it("business data never leaks into the personal context (personal resolution never returns business fields)", async () => {
    await ctx.personalProfiles.insert(USER_A);
    const resolved = await ctx.profileAccessService.resolveActiveProfile(USER_A, { kind: "personal" });
    expect(resolved.businessProfileId).toBeUndefined();
  });
});
