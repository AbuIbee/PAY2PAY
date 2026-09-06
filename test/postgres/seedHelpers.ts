import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { userAccount, personalProfile } from "@/db/schema";

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
