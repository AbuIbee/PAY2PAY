import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessProfile, personalProfile } from "@/db/schema";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import type { ProfileDisplayReader } from "./profileDisplayReader";

/**
 * Production defect remediation (party name display) — Fix 6/Legacy Party Name Rule: the confirmed
 * root cause of "Creditor: Personal profile" appearing on a real agreement. This class predates
 * Decision 4's `personal_profile.first_name`/`last_name` columns and was never updated to read them —
 * it only ever checked `legal_name`, which most personal profiles never set, so the literal fallback
 * string `"Personal profile"` — an internal placeholder, never a person's identity — was reaching the
 * UI/PDF for any such profile. Exported as a pure function so the exact fallback chain is directly
 * unit-testable without a live database: (1) first_name + last_name, (2) legacy legal_name, (3)
 * "Name not provided" — never fabricated from email, never "Personal profile". This is the ONE
 * remaining fallback `resolveAgreementPartyDisplays`'s "legacy_live" branch (agreementPartyDisplay.ts)
 * reaches for a version with no identity snapshot — the snapshot itself (Decision 7) is preferred
 * first and takes priority whenever one exists.
 */
export function resolvePersonalProfileDisplayName(row: { firstName: string | null; lastName: string | null; legalName: string | null } | undefined): string {
  if (row?.firstName?.trim() && row?.lastName?.trim()) {
    return `${row.firstName.trim()} ${row.lastName.trim()}`;
  }
  if (row?.legalName?.trim()) {
    return row.legalName.trim();
  }
  return "Name not provided";
}

export class DrizzleProfileDisplayReader implements ProfileDisplayReader {
  async getDisplayName(profileKind: ProfileKind, profileId: string): Promise<string> {
    const db = getDb();
    if (profileKind === "personal") {
      const rows = await db
        .select({ firstName: personalProfile.firstName, lastName: personalProfile.lastName, legalName: personalProfile.legalName })
        .from(personalProfile)
        .where(eq(personalProfile.id, profileId))
        .limit(1);
      return resolvePersonalProfileDisplayName(rows[0]);
    }
    const rows = await db
      .select({ displayName: businessProfile.displayName, legalBusinessName: businessProfile.legalBusinessName })
      .from(businessProfile)
      .where(eq(businessProfile.id, profileId))
      .limit(1);
    const row = rows[0];
    return row?.displayName ?? row?.legalBusinessName ?? "Business profile";
  }
}
