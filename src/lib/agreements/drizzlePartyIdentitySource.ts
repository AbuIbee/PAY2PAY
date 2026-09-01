import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessProfile, personalProfile } from "@/db/schema";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { resolvePersonalDisplayName, type PersonalAddress } from "@/lib/profiles/personalProfileService";
import type { PartyIdentitySnapshotFields, PartyIdentitySource } from "./agreementIdentitySnapshotService";

/**
 * Decision 7/8/9: reads the live profile fields a snapshot freezes at acceptance time. For a
 * personal party: first/last name (falling back to legal_name), preferred_email (only when
 * verified — Decision 6's own rule that an unverified alternate address must never enter a
 * snapshot), and city/state/postal_code/country from the structured `residential_address`. For a
 * business party: only the existing display name — Decisions 6/8/9 scope the new personal-identity
 * fields to personal parties only.
 */
export class DrizzlePartyIdentitySource implements PartyIdentitySource {
  async getPartyIdentity(profileKind: ProfileKind, profileId: string): Promise<PartyIdentitySnapshotFields> {
    const db = getDb();
    if (profileKind === "business") {
      const rows = await db
        .select({ displayName: businessProfile.displayName, legalBusinessName: businessProfile.legalBusinessName })
        .from(businessProfile)
        .where(eq(businessProfile.id, profileId))
        .limit(1);
      const row = rows[0];
      return {
        displayName: row?.displayName ?? row?.legalBusinessName ?? "A Paid2You business",
        firstName: null,
        lastName: null,
        preferredEmail: null,
        city: null,
        state: null,
        postalCode: null,
        country: null,
      };
    }

    const rows = await db.select().from(personalProfile).where(eq(personalProfile.id, profileId)).limit(1);
    const row = rows[0];
    const address = (row?.residentialAddress as PersonalAddress | null) ?? null;
    return {
      displayName: resolvePersonalDisplayName({ firstName: row?.firstName ?? null, lastName: row?.lastName ?? null, legalName: row?.legalName ?? null }),
      firstName: row?.firstName ?? null,
      lastName: row?.lastName ?? null,
      // Decision 6: only a VERIFIED preferred email is ever readable here.
      preferredEmail: row?.preferredEmailVerifiedAt ? row.preferredEmail : null,
      city: address?.city ?? null,
      state: address?.state ?? null,
      postalCode: address?.postalCode ?? null,
      country: address?.country ?? null,
    };
  }
}
