import "server-only";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mfaCredential } from "@/db/schema";
import type { RegisteredPhoneLookupResult, RegisteredPhoneReader } from "@/lib/agreementInvitations/agreementInvitationService";

/**
 * B0-B blocker correction (pre-registration invitation SMS): resolves whether a phone number belongs
 * to a registered, phone-verified Paid2You user — the only canonical phone<->user relationship this
 * codebase has. Deliberately mirrors `DrizzleUserContactReader.getPhone`'s own identical query and its
 * own doc comment for why: `user_account.phone` is a dead, always-null column, so a verified SMS MFA
 * credential (`mfa_credential` where `method = 'sms'`, `verifiedAt` set, not disabled) is the only
 * proof this codebase has that a given phone number is genuinely controlled by a specific user.
 *
 * Codex B0-B blocker correction (B0-B-003): the inspected `mfa_credential` schema has no unique
 * constraint on `phone_ref`, so this query can legitimately return credentials belonging to more than
 * one distinct user for the same phone. The original implementation ordered by most-recently-verified
 * and took the first row — silently picking an arbitrary account when two different users happened to
 * share a phone. This version retrieves every matching row (deliberately no `.limit(1)`) and collects
 * the DISTINCT set of user ids: zero rows is `no_match`; exactly one distinct user id — however many
 * credential rows that one user has (e.g. re-enrolled after disabling a prior credential) — is
 * `unique_match`; more than one distinct user id is `ambiguous_match`, and the caller must never select
 * either candidate for an automated send (see `AgreementInvitationService.createInvitation`'s own
 * identity-resolution doc comment).
 */
export class DrizzleRegisteredPhoneReader implements RegisteredPhoneReader {
  async findUserIdByVerifiedPhone(phone: string): Promise<RegisteredPhoneLookupResult> {
    const db = getDb();
    const rows = await db
      .select({ userId: mfaCredential.userId })
      .from(mfaCredential)
      .where(and(eq(mfaCredential.phoneRef, phone), eq(mfaCredential.method, "sms"), isNotNull(mfaCredential.verifiedAt), isNull(mfaCredential.disabledAt)));
    const distinctUserIds = new Set(rows.map((row) => row.userId));
    if (distinctUserIds.size === 0) return { kind: "no_match" };
    if (distinctUserIds.size === 1) return { kind: "unique_match", userId: [...distinctUserIds][0]! };
    return { kind: "ambiguous_match" };
  }
}
