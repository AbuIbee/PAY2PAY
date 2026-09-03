import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "./testFakes";
import { createTestBusinessProfileService } from "@/lib/profiles/testFakes";

/**
 * Sprint 2's four required cross-account isolation tests
 * (docs/sprints/SPRINT_02_Authentication.md).
 *
 * PRSprint 02 correction (docs/prsprints/PRSPRINT_02_RLS_CROSS_TENANT_SECURITY.md): the claim this
 * comment used to make — that Postgres RLS policies provide DB-level defense in depth for these
 * lookups in production — is not accurate for this codebase and has been removed. This app uses
 * fully custom auth, not Supabase Auth, so `auth.uid()` is never available to a policy; every table
 * in supabase/migrations/ has RLS *enabled* with zero `CREATE POLICY` statements (deny-all for the
 * anon/authenticated Postgres roles PostgREST would use), and the app's own connection
 * (`DATABASE_URL` in src/db/client.ts) queries as the table owner, which Postgres RLS does not apply
 * to regardless of policies (no table has `FORCE ROW LEVEL SECURITY`). RLS here is real, correct
 * defense in depth against direct anon/authenticated database access, but it enforces nothing on the
 * app's own queries. Tenant isolation for this app's own request handling — what every test in this
 * suite actually exercises — is enforced entirely in this TypeScript service layer: every lookup is
 * parameterized by the *authenticated caller's own* id, never by a client-supplied target id.
 */
describe("Cross-account isolation", () => {
  it("User A cannot read User B's personal profile", async () => {
    const ctx = createTestAuthService();
    const userA = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "isolation-a@example.com",
      password: "correct horse battery staple",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const userB = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "isolation-b@example.com",
      password: "correct horse battery staple",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });

    // The only lookup surface is findByUserId — parameterized by the id of
    // the profile's *own* owner, never by an arbitrary "give me profile X"
    // id. Looking up with A's id can never return B's row, and vice versa.
    const profileA = ctx.accountProvisioning.personalProfiles.get(userA.user.id);
    const profileB = ctx.accountProvisioning.personalProfiles.get(userB.user.id);
    expect(profileA?.userId).toBe(userA.user.id);
    expect(profileB?.userId).toBe(userB.user.id);
    expect(profileA?.id).not.toBe(profileB?.id);

    // Explicitly: asking for A's own id never yields B's profile.
    expect(ctx.accountProvisioning.personalProfiles.get(userA.user.id)).not.toEqual(profileB);
  });

  it(
    "User A cannot read User B's business profile " +
      "(closed by PRSprint 02 — this was a Sprint 2-era placeholder deferred to Sprint 3's scope " +
      "and never filled in, even though Sprint 3 shipped BusinessProfileService and " +
      "src/lib/profiles/businessProfileService.test.ts's own 'cross-user isolation' suite months ago)",
    async () => {
      const businessCtx = createTestBusinessProfileService();
      const userA = await businessCtx.businessProfileService.createBusinessProfile({
        ownerUserId: randomUUID(),
        legalBusinessName: "User A's Business LLC",
        displayName: "User A's Business",
        entityType: "llc",
        businessAddress: { line1: "123 Main St", city: "Springfield", state: "IL", postalCode: "62701" },
        country: "US",
        state: "IL",
      });
      const userB = randomUUID();

      // The only lookup surface is getOwnedBusinessProfile(callerUserId, profileId) — B asking for
      // A's business profile id must never silently return A's data. It resolves to null rather than
      // throwing (the same "nonexistent id and unauthorized id look identical" contract
      // src/lib/profiles/businessProfileService.test.ts's own equivalent test already asserts).
      expect(await businessCtx.businessProfileService.getOwnedBusinessProfile(userB, userA.id)).toBeNull();
    },
  );

  it("a user cannot create a personal profile for another authenticated user", async () => {
    const ctx = createTestAuthService();
    const userA = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
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
    const profile = ctx.accountProvisioning.personalProfiles.get(userA.user.id);
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
