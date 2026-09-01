import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { generateOpaqueToken, hashOpaqueToken } from "@/lib/auth/token";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { EmailSender } from "@/lib/notify/emailSender";

/**
 * Decision 4: the application-level shape `personal_profile.residential_address` (jsonb) always
 * holds — never a duplicate set of street/city/state/ZIP columns. `line2` is the only optional field
 * (Decision 5's own explicit list). All of this is personal information (never described as
 * non-PII anywhere in this codebase or its comments).
 */
export interface PersonalAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface PersonalProfileRecord {
  id: string;
  userId: string;
  legalName: string | null;
  firstName: string | null;
  lastName: string | null;
  preferredEmail: string | null;
  preferredEmailVerifiedAt: Date | null;
  contactPhone: string | null;
  residentialAddress: PersonalAddress | null;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PersonalProfileRepository {
  findByUserId(userId: string): Promise<PersonalProfileRecord | null>;
  findById(id: string): Promise<PersonalProfileRecord | null>;
  update(
    id: string,
    input: {
      firstName: string;
      lastName: string;
      preferredEmail: string;
      preferredEmailVerifiedAt: Date | null;
      contactPhone: string;
      residentialAddress: PersonalAddress;
    },
  ): Promise<PersonalProfileRecord>;
}

export interface PreferredEmailVerificationRepository {
  insert(input: { personalProfileId: string; email: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }>;
  findByTokenHash(tokenHash: string): Promise<{ id: string; personalProfileId: string; email: string; expiresAt: Date; consumedAt: Date | null } | null>;
  consume(id: string): Promise<void>;
}

/** Narrow view onto AuthService — only what's needed to compare against the already-verified auth email. Real implementation: DrizzleUserAuthEmailReader. */
export interface UserAuthEmailReader {
  getVerifiedEmail(userId: string): Promise<string | null>;
}

export interface PersonalProfileServiceDeps {
  profiles: PersonalProfileRepository;
  verificationTokens: PreferredEmailVerificationRepository;
  authEmails: UserAuthEmailReader;
  emailSender: EmailSender;
  audit: AuditService;
  appUrl: string;
}

const PREFERRED_EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Decision 5's own exact required-field list (address line 2 excepted). */
export const REQUIRED_PROFILE_FIELDS = ["firstName", "lastName", "preferredEmail", "contactPhone", "line1", "city", "state", "postalCode", "country"] as const;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Decision 4: first_name + last_name, falling back to the legacy legal_name, never a hardcoded placeholder unless nothing at all is on file. */
export function resolvePersonalDisplayName(profile: { firstName: string | null; lastName: string | null; legalName: string | null }): string {
  if (profile.firstName?.trim() && profile.lastName?.trim()) {
    return `${profile.firstName.trim()} ${profile.lastName.trim()}`;
  }
  return profile.legalName?.trim() || "A Paid2You member";
}

/**
 * Decision 3/4/5/6 (canonical connection/profile remediation): the first read/write service for
 * `personal_profile`'s own contact information — every prior column was write-once at signup; this
 * is the first mutation path. Own-profile-only (Decision 10: "Users may read/update only their own
 * profile"): every method is keyed by `userId`, never a bare profile id from the caller.
 */
export class PersonalProfileService {
  constructor(private readonly deps: PersonalProfileServiceDeps) {}

  async getMyProfile(userId: string): Promise<PersonalProfileRecord> {
    const profile = await this.deps.profiles.findByUserId(userId);
    if (!profile) throw new ValidationError("No personal profile exists for this account.");
    return profile;
  }

  /**
   * Decision 6's exact rule: preferred_email defaults to (and, while unchanged, is always considered
   * verified alongside) the already-verified auth email; changing it to something else clears
   * verified-status until a dedicated token confirms the new address, and never touches
   * user_account.email itself.
   */
  async updateMyProfile(
    userId: string,
    input: {
      firstName: string;
      lastName: string;
      preferredEmail: string;
      contactPhone: string;
      address: PersonalAddress;
    },
  ): Promise<PersonalProfileRecord> {
    const profile = await this.getMyProfile(userId);
    if (!input.firstName.trim()) throw new ValidationError("First name is required.");
    if (!input.lastName.trim()) throw new ValidationError("Last name is required.");
    const preferredEmail = normalizeEmail(input.preferredEmail);
    if (!preferredEmail || !preferredEmail.includes("@")) throw new ValidationError("A valid preferred email is required.");
    if (!input.contactPhone.trim()) throw new ValidationError("A contact phone number is required.");
    this.requireAddress(input.address);

    const verifiedAuthEmail = await this.deps.authEmails.getVerifiedEmail(userId);
    const matchesVerifiedAuthEmail = !!verifiedAuthEmail && normalizeEmail(verifiedAuthEmail) === preferredEmail;
    const alreadyVerifiedAsIs = profile.preferredEmail === preferredEmail && !!profile.preferredEmailVerifiedAt;

    const updated = await this.deps.profiles.update(profile.id, {
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      preferredEmail,
      preferredEmailVerifiedAt: matchesVerifiedAuthEmail || alreadyVerifiedAsIs ? (alreadyVerifiedAsIs ? profile.preferredEmailVerifiedAt : new Date()) : null,
      contactPhone: input.contactPhone.trim(),
      residentialAddress: input.address,
    });

    await this.deps.audit.record({
      actorUserId: userId,
      actorRole: "personal_user",
      profileKind: "personal",
      profileId: profile.id,
      agreementId: null,
      action: "personal_profile_updated",
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: { preferredEmailChanged: profile.preferredEmail !== preferredEmail },
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
    });

    // A genuinely new, not-yet-verified preferred email — send the dedicated verification link.
    // Never sent for the default (matches verified auth email) or unchanged-and-already-verified case.
    if (!matchesVerifiedAuthEmail && !alreadyVerifiedAsIs) {
      await this.sendVerificationEmail(profile.id, preferredEmail);
    }

    return updated;
  }

  async resendPreferredEmailVerification(userId: string): Promise<void> {
    const profile = await this.getMyProfile(userId);
    if (!profile.preferredEmail) throw new ValidationError("No preferred email is set.");
    if (profile.preferredEmailVerifiedAt) return; // already verified — quietly no-ops
    await this.sendVerificationEmail(profile.id, profile.preferredEmail);
  }

  private async sendVerificationEmail(personalProfileId: string, email: string): Promise<void> {
    const rawToken = generateOpaqueToken();
    await this.deps.verificationTokens.insert({
      personalProfileId,
      email,
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt: new Date(Date.now() + PREFERRED_EMAIL_VERIFICATION_TTL_MS),
    });
    const link = `${this.deps.appUrl}/account/profile/verify-email?token=${rawToken}`;
    await this.deps.emailSender.send({
      to: email,
      subject: "Confirm your preferred contact email on PAY2PAY",
      body: `Confirm this is the email you'd like agreements to show and use for contact: ${link}\n\nThis link expires in 24 hours. Your PAY2PAY login email is unchanged.`,
      ctaUrl: link,
      ctaText: "Confirm email",
    });
  }

  /** Decision 6: never represents an unverified alternate address as verified. */
  async confirmPreferredEmail(rawToken: string): Promise<void> {
    const record = await this.deps.verificationTokens.findByTokenHash(hashOpaqueToken(rawToken));
    if (!record || record.consumedAt || record.expiresAt.getTime() <= Date.now()) {
      throw new ValidationError("This verification link is invalid or has expired.");
    }
    const profile = await this.deps.profiles.findById(record.personalProfileId);
    if (!profile) throw new ValidationError("This verification link is invalid or has expired.");
    await this.deps.verificationTokens.consume(record.id);
    // Only take effect if the profile's preferred_email still matches what this token verified — a
    // stale link for an address the user has since changed away from must never resurrect it.
    if (normalizeEmail(profile.preferredEmail ?? "") !== normalizeEmail(record.email)) return;
    await this.deps.profiles.update(profile.id, {
      firstName: profile.firstName ?? "",
      lastName: profile.lastName ?? "",
      preferredEmail: profile.preferredEmail!,
      preferredEmailVerifiedAt: new Date(),
      contactPhone: profile.contactPhone ?? "",
      residentialAddress: profile.residentialAddress ?? { line1: "", line2: null, city: "", state: "", postalCode: "", country: "" },
    });
  }

  /**
   * Corrected per explicit review: "before a personal user can COMPLETE their agreement
   * participation... require ALL of: First name, Last name, Contact phone, Verified preferred
   * email, Address line 1, City, State/province, ZIP/postal code, Country" — only address line 2 is
   * optional. This is now the SAME required-field list `REQUIRED_PROFILE_FIELDS`/
   * `checkProfileCompleteness` define for the profile form itself — an agreement is exactly the kind
   * of legally meaningful participation the full profile is required for, so there is no narrower
   * gate anymore. Shares `missingRequiredFields` with `checkProfileCompleteness` so the two can never
   * drift apart again.
   */
  async checkAgreementParticipationReadiness(userId: string): Promise<{ ready: boolean; missingFields: string[] }> {
    const profile = await this.deps.profiles.findByUserId(userId);
    const missing = this.missingRequiredFields(profile);
    return { ready: missing.length === 0, missingFields: missing };
  }

  /** Full profile-form completeness (address line 2 excepted) — identical requirement to `checkAgreementParticipationReadiness`. */
  async checkProfileCompleteness(userId: string): Promise<{ complete: boolean; missingFields: string[] }> {
    const profile = await this.deps.profiles.findByUserId(userId);
    const missing = this.missingRequiredFields(profile);
    return { complete: missing.length === 0, missingFields: missing };
  }

  private missingRequiredFields(profile: PersonalProfileRecord | null): string[] {
    const missing: string[] = [];
    if (!profile?.firstName?.trim()) missing.push("firstName");
    if (!profile?.lastName?.trim()) missing.push("lastName");
    if (!profile?.preferredEmail?.trim() || !profile.preferredEmailVerifiedAt) missing.push("preferredEmail");
    if (!profile?.contactPhone?.trim()) missing.push("contactPhone");
    const address = profile?.residentialAddress;
    if (!address?.line1?.trim()) missing.push("line1");
    if (!address?.city?.trim()) missing.push("city");
    if (!address?.state?.trim()) missing.push("state");
    if (!address?.postalCode?.trim()) missing.push("postalCode");
    if (!address?.country?.trim()) missing.push("country");
    return missing;
  }

  private requireAddress(address: PersonalAddress): void {
    if (!address.line1.trim()) throw new ValidationError("Address line 1 is required.");
    if (!address.city.trim()) throw new ValidationError("City is required.");
    if (!address.state.trim()) throw new ValidationError("State/province is required.");
    if (!address.postalCode.trim()) throw new ValidationError("ZIP/postal code is required.");
    if (!address.country.trim()) throw new ValidationError("Country is required.");
  }

  /** Cross-user isolation: never returns anyone's profile but the caller's own. */
  async requireOwnProfile(userId: string, personalProfileId: string): Promise<PersonalProfileRecord> {
    const profile = await this.deps.profiles.findById(personalProfileId);
    if (!profile || profile.userId !== userId) throw new ForbiddenError("You do not have access to this profile.");
    return profile;
  }
}
