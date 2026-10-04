import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { businessProfile, pricingPlan, pricingPlanEntitlement, subscription, userAccount, personalProfile } from "@/db/schema";

/**
 * R07 (DB integrity & concurrency hardening): minimal real-row seeding shared by the
 * `*.postgres.test.ts` suites. Deliberately bypasses the full signup/verification flow — these
 * suites test transaction/locking behavior at the repository layer, not identity/auth, so a bare
 * `user_account` + `personal_profile` pair (the minimum the schema's own FK constraints require) is
 * all that's needed to satisfy foreign keys and `DrizzleProfileOwnerReader` lookups.
 */
export async function seedPersonalUser(emailPrefix: string): Promise<{ userId: string; profileId: string }> {
  const db = getDb();
  const [user] = await db
    .insert(userAccount)
    .values({
      email: `${emailPrefix}-${randomUUID()}@postgres-test.example`,
      authCredentialRef: `test-cred-${randomUUID()}`,
    })
    .returning({ id: userAccount.id });
  if (!user) throw new Error("seedPersonalUser: user_account insert returned no row");

  const [profile] = await db
    .insert(personalProfile)
    .values({ userId: user.id })
    .returning({ id: personalProfile.id });
  if (!profile) throw new Error("seedPersonalUser: personal_profile insert returned no row");

  return { userId: user.id, profileId: profile.id };
}

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02): minimal real-row seeding for the arrangement
 * usage-metering Postgres suite — a business_profile, an ad hoc test pricing_plan/entitlement pair
 * (deliberately NOT the real seedCanonicalBusinessPlans.ts catalog, so each test can pick a small,
 * fast-to-reach `new_arrangements_monthly` limit), and an active subscription linking them. Mirrors
 * seedPersonalUser's own "bypass the full flow, satisfy only what FK constraints/the code under test
 * actually need" precedent.
 */
export async function seedBusinessOrganizationWithSubscription(input: {
  namePrefix: string;
  newArrangementsMonthlyLimit: number | null;
}): Promise<{ organizationId: string; subscriptionId: string; planCode: string }> {
  const db = getDb();
  const owner = await seedPersonalUser(`${input.namePrefix}-owner`);

  const [org] = await db
    .insert(businessProfile)
    .values({
      ownerUserId: owner.userId,
      legalBusinessName: `${input.namePrefix} LLC ${randomUUID()}`,
      displayName: `${input.namePrefix} LLC`,
      entityType: "LLC",
      state: "DE",
    })
    .returning({ id: businessProfile.id });
  if (!org) throw new Error("seedBusinessOrganizationWithSubscription: business_profile insert returned no row");

  const planCode = `test_plan_${randomUUID()}`;
  const [plan] = await db
    .insert(pricingPlan)
    .values({ kind: "business", code: planCode, name: `${input.namePrefix} test plan`, monthlyFeeMinorUnits: 0 })
    .returning({ id: pricingPlan.id });
  if (!plan) throw new Error("seedBusinessOrganizationWithSubscription: pricing_plan insert returned no row");

  await db
    .insert(pricingPlanEntitlement)
    .values({ pricingPlanId: plan.id, featureKey: "new_arrangements_monthly", enabled: true, limitValue: input.newArrangementsMonthlyLimit });

  const [sub] = await db
    .insert(subscription)
    .values({ profileKind: "business", profileId: org.id, pricingPlanId: plan.id, status: "active" })
    .returning({ id: subscription.id });
  if (!sub) throw new Error("seedBusinessOrganizationWithSubscription: subscription insert returned no row");

  return { organizationId: org.id, subscriptionId: sub.id, planCode };
}
