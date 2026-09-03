import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { betaInviteCode, businessProfile, personalProfile, userAccount } from "@/db/schema";
import { ConfigurationError, ValidationError } from "@/lib/errors";
import type {
  AccountProvisioningRepository,
  BusinessSignupDetails,
  PersonalSignupIdentity,
  ProvisionedAccount,
  UserAccountRecord,
} from "./authService";
import { generatePublicReferenceCode } from "./token";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

type UserAccountRow = typeof userAccount.$inferSelect;

function toUserRecord(row: UserAccountRow): UserAccountRecord {
  return {
    id: row.id,
    email: row.email,
    authCredentialRef: row.authCredentialRef,
    status: row.status,
    platformRole: row.platformRole,
    accountClassification: row.accountClassification,
    dateOfBirth: row.dateOfBirth,
    emailVerifiedAt: row.emailVerifiedAt,
    publicReference: row.publicReference,
  };
}

/**
 * Real implementation of AccountProvisioningRepository — see that interface's own doc comment in
 * authService.ts. Runs entirely inside one transaction, mirroring
 * DrizzleRelationshipPairResolver.resolveForExactParties's established pattern (raw `tx` calls
 * directly, bypassing the ordinary per-table repository classes, which each open their own
 * non-composable getDb() call and so can't participate in a caller's transaction). A thrown error at
 * any point — a duplicate business name hitting the unique index, an invalid/already-claimed beta
 * invite code, a DB constraint violation — rolls back every row this method would otherwise have
 * inserted, so a failed signup can never leave a user_account behind with no usable profile (or, for
 * business signup, no business_profile/ownership).
 */
export class DrizzleAccountProvisioningRepository implements AccountProvisioningRepository {
  async provisionPersonalAccount(input: {
    email: string;
    authCredentialRef: string;
    dateOfBirth: string;
    identity: PersonalSignupIdentity;
    betaInviteCode: string | null;
  }): Promise<ProvisionedAccount> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [userRow] = await tx
        .insert(userAccount)
        .values({
          email: input.email,
          authCredentialRef: input.authCredentialRef,
          dateOfBirth: input.dateOfBirth,
          publicReference: generatePublicReferenceCode(),
        })
        .returning();
      if (!userRow) throw new ConfigurationError("user_account insert returned no row during signup");

      await claimBetaInviteCodeOrThrow(tx, input.betaInviteCode, userRow.id);

      const [profileRow] = await tx
        .insert(personalProfile)
        .values({
          userId: userRow.id,
          firstName: input.identity.firstName.trim(),
          middleName: input.identity.middleName?.trim() || null,
          lastName: input.identity.lastName.trim(),
          preferredEmail: input.email,
          preferredEmailVerifiedAt: null, // never fabricated — see PreferredEmailSyncTarget
          contactPhone: input.identity.contactPhone.trim(),
          residentialAddress: toAddressJson(input.identity.address),
        })
        .returning();
      if (!profileRow) throw new ConfigurationError("personal_profile insert returned no row during signup");

      return { user: toUserRecord(userRow), personalProfileId: profileRow.id, businessProfileId: null };
    });
  }

  async provisionBusinessAccount(input: {
    email: string;
    authCredentialRef: string;
    dateOfBirth: string;
    identity: PersonalSignupIdentity;
    business: BusinessSignupDetails;
    betaInviteCode: string | null;
  }): Promise<ProvisionedAccount> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [userRow] = await tx
        .insert(userAccount)
        .values({
          email: input.email,
          authCredentialRef: input.authCredentialRef,
          dateOfBirth: input.dateOfBirth,
          publicReference: generatePublicReferenceCode(),
        })
        .returning();
      if (!userRow) throw new ConfigurationError("user_account insert returned no row during signup");

      await claimBetaInviteCodeOrThrow(tx, input.betaInviteCode, userRow.id);

      const [profileRow] = await tx
        .insert(personalProfile)
        .values({
          userId: userRow.id,
          firstName: input.identity.firstName.trim(),
          middleName: input.identity.middleName?.trim() || null,
          lastName: input.identity.lastName.trim(),
          preferredEmail: input.email,
          preferredEmailVerifiedAt: null,
          contactPhone: input.identity.contactPhone.trim(),
          residentialAddress: toAddressJson(input.identity.address),
        })
        .returning();
      if (!profileRow) throw new ConfigurationError("personal_profile insert returned no row during signup");

      // Reuses business_profile exactly as BusinessProfileService.createBusinessProfile does — same
      // table, same columns, same ownerUserId-is-authoritative ownership model (profileAccessService.ts)
      // — just a raw transactional insert instead of that service's own non-composable getDb() call.
      // No full tax-ID number is ever written here; see BusinessSignupDetails's own doc comment.
      const [businessRow] = await tx
        .insert(businessProfile)
        .values({
          ownerUserId: userRow.id,
          legalBusinessName: input.business.legalBusinessName.trim(),
          displayName: input.business.dbaName?.trim() || input.business.legalBusinessName.trim(),
          entityType: input.business.entityType.trim(),
          taxIdType: input.business.taxIdType.trim(),
          businessPhone: input.business.businessPhone?.trim() || null,
          businessAddress: {
            line1: input.business.businessAddress.line1.trim(),
            line2: input.business.businessAddress.line2?.trim() || null,
            city: input.business.businessAddress.city.trim(),
            state: input.business.state.trim(),
            postalCode: input.business.businessAddress.postalCode.trim(),
          },
          country: input.business.country.trim(),
          state: input.business.state.trim(),
        })
        .returning();
      if (!businessRow) throw new ConfigurationError("business_profile insert returned no row during signup");

      return { user: toUserRecord(userRow), personalProfileId: profileRow.id, businessProfileId: businessRow.id };
    });
  }
}

function toAddressJson(address: PersonalSignupIdentity["address"]) {
  return {
    line1: address.line1.trim(),
    line2: address.line2?.trim() || null,
    city: address.city.trim(),
    state: address.state.trim(),
    postalCode: address.postalCode.trim(),
    country: address.country.trim(),
  };
}

/**
 * Same atomic guarantee as BetaInviteRepository.claimCode (`WHERE code = $1 AND used_by_user_id IS
 * NULL`, src/lib/compliance/drizzleBetaInviteRepository.ts) but run against `tx` so it commits or
 * rolls back with the rest of this transaction — see AccountProvisioningRepository's own doc comment
 * for why the two-phase pre-check-then-consume design's race window is closed by folding this in here.
 */
async function claimBetaInviteCodeOrThrow(tx: Tx, code: string | null, usedByUserId: string): Promise<void> {
  if (!code) return;
  const [claimed] = await tx
    .update(betaInviteCode)
    .set({ usedByUserId, usedAt: new Date() })
    .where(and(eq(betaInviteCode.code, code.trim()), isNull(betaInviteCode.usedByUserId)))
    .returning();
  if (!claimed) {
    throw new ValidationError("This invite code is invalid or has already been used.");
  }
}
