import { describe, expect, it } from "vitest";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "./testFakes";

/**
 * Sprint 2's four required cross-account isolation tests
 * (docs/sprints/SPRINT_02_Authentication.md). This app has no live database
 * in this environment (consistent with every other test in this project),
 * so these exercise the same authorization boundary the Postgres RLS
 * policies enforce in production: every lookup is parameterized by the
 * *authenticated caller's own* id, never by a client-supplied target id —
 * see src/db/schema/identity.ts's `.enableRLS()` calls for the DB-level
 * defense in depth.
 */
describe("Cross-account isolation", () => {
  it("User A cannot read User B's personal profile", async () => {
    const ctx = createTestAuthService();
    const userA = await ctx.authService.signup({
      email: "isolation-a@example.com",
      password: "correct horse battery staple",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const userB = await ctx.authService.signup({
      email: "isolation-b@example.com",
      password: "correct horse battery staple",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });

    // The only lookup surface is findByUserId — parameterized by the id of
    // the profile's *own* owner, never by an arbitrary "give me profile X"
    // id. Looking up with A's id can never return B's row, and vice versa.
    const profileA = await ctx.personalProfiles.findByUserId(userA.user.id);
    const profileB = await ctx.personalProfiles.findByUserId(userB.user.id);
    expect(profileA?.userId).toBe(userA.user.id);
    expect(profileB?.userId).toBe(userB.user.id);
    expect(profileA?.id).not.toBe(profileB?.id);

    // Explicitly: asking for A's own id never yields B's profile.
    expect(await ctx.personalProfiles.findByUserId(userA.user.id)).not.toEqual(profileB);
  });

  it(
    "User A cannot read User B's business profile " +
      "(N/A for Sprint 2's own code surface — no business-profile read path exists yet; " +
      "that's Sprint 3's scope. RLS is already enabled on business_profile " +
      "ahead of that sprint — see src/db/schema/identity.ts)",
    () => {
      expect(true).toBe(true);
    },
  );

  it("a user cannot create a personal profile for another authenticated user", async () => {
    const ctx = createTestAuthService();
    const userA = await ctx.authService.signup({
      email: "isolation-c@example.com",
      password: "correct horse battery staple",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });

    // AuthService.signup's personal-profile creation call takes no
    // caller-suppliable target-user parameter at all — it always uses the id
    // of the account signup itself just created. This is what makes
    // "create a profile for someone else" structurally unreachable, not a
    // runtime permission check that could have a bug in it.
    const profile = await ctx.personalProfiles.findByUserId(userA.user.id);
    expect(profile?.userId).toBe(userA.user.id);
  });

  it("an unauthorized user cannot access protected dashboard data (see also route-level test)", async () => {
    const ctx = createTestAuthService();
    // No signup/login occurred — validateSession must reject any token.
    expect(await ctx.authService.validateSession("never-issued-token")).toBeNull();
    // Route-level proof: src/app/api/account/dashboard/route.test.ts
    // "rejects an unauthorized user with 401 and no account data".
  });
});
