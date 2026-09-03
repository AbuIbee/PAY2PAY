import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import type { BetaInviteRepository } from "@/lib/compliance/betaInviteService";
import { ConfigurationError, ConflictError, ValidationError } from "@/lib/errors";
import type { EmailSender } from "@/lib/notify/emailSender";
import { AuthService } from "./authService";
import { generatePublicReferenceCode } from "./token";
import type {
  AccountProvisioningRepository,
  BusinessSignupDetails,
  EmailVerificationTokenRecord,
  EmailVerificationTokenRepository,
  PasswordResetTokenRecord,
  PasswordResetTokenRepository,
  PersonalProfileRecord,
  PersonalProfileRepository,
  PersonalSignupIdentity,
  PreferredEmailSyncTarget,
  ProvisionedAccount,
  SessionRecord,
  SessionRepository,
  AccountClassification,
  PlatformRole,
  UserAccountRecord,
  UserAccountRepository,
} from "./authService";

/**
 * Test-only in-memory doubles for AuthService's repositories, shared by
 * authService.test.ts and the API route tests under src/app/api/auth/**.
 * Not imported by any production code path — mirrors the pattern
 * src/lib/audit/auditService.test.ts uses for AuditEventRepository, just
 * factored out so every auth test doesn't redefine it.
 */

export class InMemoryUserAccountRepository implements UserAccountRepository {
  /** Public (unlike most fields here) so Sprint 6A's admin test fakes can list/aggregate users without a bulk-list method on the real interface — mirrors InMemoryAgreementRepository.byId's pattern. */
  byId = new Map<string, UserAccountRecord>();

  async findByEmail(email: string): Promise<UserAccountRecord | null> {
    for (const user of this.byId.values()) {
      if (user.email === email) return user;
    }
    return null;
  }

  async findById(id: string): Promise<UserAccountRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async insert(input: {
    email: string;
    authCredentialRef: string;
    dateOfBirth: string;
  }): Promise<UserAccountRecord> {
    const user: UserAccountRecord = {
      id: randomUUID(),
      email: input.email,
      authCredentialRef: input.authCredentialRef,
      status: "active",
      platformRole: "member",
      accountClassification: "production",
      dateOfBirth: input.dateOfBirth,
      emailVerifiedAt: null,
      publicReference: generatePublicReferenceCode(),
    };
    this.byId.set(user.id, user);
    return user;
  }

  async markEmailVerified(userId: string): Promise<void> {
    const user = this.byId.get(userId);
    if (user) user.emailVerifiedAt = new Date();
  }

  async updateLastLogin(): Promise<void> {
    // No last-login assertions in these tests; no-op is sufficient.
  }

  async updatePasswordHash(userId: string, authCredentialRef: string): Promise<void> {
    const user = this.byId.get(userId);
    if (user) user.authCredentialRef = authCredentialRef;
  }

  async updateStatus(userId: string, status: string): Promise<void> {
    this.setStatus(userId, status);
  }

  async updatePlatformRole(userId: string, platformRole: PlatformRole): Promise<void> {
    const user = this.byId.get(userId);
    if (user) user.platformRole = platformRole;
  }

  async updateAccountClassification(userId: string, accountClassification: AccountClassification): Promise<void> {
    const user = this.byId.get(userId);
    if (user) user.accountClassification = accountClassification;
  }

  async setPublicReference(userId: string, publicReference: string): Promise<void> {
    const user = this.byId.get(userId);
    if (user) user.publicReference = publicReference;
  }

  async findByPublicReference(publicReference: string): Promise<UserAccountRecord | null> {
    for (const user of this.byId.values()) {
      if (user.publicReference === publicReference) return user;
    }
    return null;
  }

  /** Test-only helper, not part of the UserAccountRepository interface. */
  setStatus(userId: string, status: string): void {
    const user = this.byId.get(userId);
    if (user) user.status = status;
  }

  /** Test-only helper, not part of the UserAccountRepository interface. */
  setPlatformRole(userId: string, platformRole: PlatformRole): void {
    const user = this.byId.get(userId);
    if (user) user.platformRole = platformRole;
  }
}

export class InMemorySessionRepository implements SessionRepository {
  private byId = new Map<string, SessionRecord>();

  async insert(input: {
    userId: string;
    sessionTokenHash: string;
    expiresAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<SessionRecord> {
    const now = new Date();
    const session: SessionRecord = {
      id: randomUUID(),
      userId: input.userId,
      sessionTokenHash: input.sessionTokenHash,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: input.expiresAt,
      revokedAt: null,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    };
    this.byId.set(session.id, session);
    return session;
  }

  async findByTokenHash(sessionTokenHash: string): Promise<SessionRecord | null> {
    for (const session of this.byId.values()) {
      if (session.sessionTokenHash === sessionTokenHash) return session;
    }
    return null;
  }

  async findById(id: string): Promise<SessionRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async revoke(id: string): Promise<void> {
    const session = this.byId.get(id);
    if (session) session.revokedAt = new Date();
  }

  async revokeAllForUser(userId: string): Promise<void> {
    for (const session of this.byId.values()) {
      if (session.userId === userId) session.revokedAt = new Date();
    }
  }

  async touchLastSeen(id: string): Promise<void> {
    const session = this.byId.get(id);
    if (session) session.lastSeenAt = new Date();
  }

  async listActiveForUser(userId: string, now: Date): Promise<SessionRecord[]> {
    return [...this.byId.values()]
      .filter((s) => s.userId === userId && !s.revokedAt && s.expiresAt.getTime() > now.getTime())
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  }
}

export class InMemoryPersonalProfileRepository implements PersonalProfileRepository {
  byUserId = new Map<string, PersonalProfileRecord>();

  async insert(userId: string): Promise<PersonalProfileRecord> {
    // Mirrors the real schema's UNIQUE constraint on personal_profile.user_id
    // (src/db/schema/identity.ts) — Sprint 3's "one personal profile maximum"
    // is enforced at the database level; this fake reproduces that so tests
    // against it are meaningful.
    if (this.byUserId.has(userId)) {
      throw new ConflictError("This user already has a personal profile.");
    }
    const record: PersonalProfileRecord = { id: randomUUID(), userId };
    this.byUserId.set(userId, record);
    return record;
  }

  async findByUserId(userId: string): Promise<PersonalProfileRecord | null> {
    return this.byUserId.get(userId) ?? null;
  }
}

export interface StoredPersonalProfile {
  id: string;
  userId: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  preferredEmail: string;
  preferredEmailVerifiedAt: Date | null;
  contactPhone: string;
  residentialAddress: { line1: string; line2: string | null; city: string; state: string; postalCode: string; country: string };
}

export interface StoredBusinessProfile {
  id: string;
  ownerUserId: string;
  legalBusinessName: string;
  displayName: string;
  entityType: string;
  taxIdType: string;
  businessPhone: string | null;
  businessAddress: { line1: string; line2: string | null; city: string; postalCode: string };
  country: string;
  state: string;
}

/**
 * Signup/onboarding redesign: in-memory double for AccountProvisioningRepository, sharing the same
 * InMemoryUserAccountRepository instance AuthService's other tests already assert against (`ctx.users`)
 * — mirrors the real DrizzleAccountProvisioningRepository's "everything commits together or nothing
 * does" guarantee by only writing the new user into `users` after a beta-invite claim (if any) has
 * already succeeded. Also implements PreferredEmailSyncTarget — in production these are two separate
 * Drizzle classes hitting the same personal_profile table; combining them here is just fake-plumbing
 * economy, not a production design choice.
 */
export class InMemoryAccountProvisioningRepository implements AccountProvisioningRepository, PreferredEmailSyncTarget {
  personalProfiles = new Map<string, StoredPersonalProfile>();
  businessProfiles = new Map<string, StoredBusinessProfile>();

  constructor(
    private readonly users: InMemoryUserAccountRepository,
    private readonly betaInvites?: BetaInviteRepository,
  ) {}

  private newUser(input: { email: string; authCredentialRef: string; dateOfBirth: string }): UserAccountRecord {
    return {
      id: randomUUID(),
      email: input.email,
      authCredentialRef: input.authCredentialRef,
      status: "active",
      platformRole: "member",
      accountClassification: "production",
      dateOfBirth: input.dateOfBirth,
      emailVerifiedAt: null,
      publicReference: generatePublicReferenceCode(),
    };
  }

  private async claimInviteOrThrow(code: string | null, usedByUserId: string): Promise<void> {
    if (!code) return;
    if (!this.betaInvites) {
      throw new ConfigurationError("No BetaInviteRepository configured for this test's AuthService.");
    }
    const claimed = await this.betaInvites.claimCode(code.trim(), usedByUserId);
    if (!claimed) {
      throw new ValidationError("This invite code is invalid or has already been used.");
    }
  }

  private storeProfile(user: UserAccountRecord, identity: PersonalSignupIdentity): string {
    const profileId = randomUUID();
    this.personalProfiles.set(user.id, {
      id: profileId,
      userId: user.id,
      firstName: identity.firstName.trim(),
      middleName: identity.middleName?.trim() || null,
      lastName: identity.lastName.trim(),
      preferredEmail: user.email,
      preferredEmailVerifiedAt: null,
      contactPhone: identity.contactPhone.trim(),
      residentialAddress: { ...identity.address },
    });
    return profileId;
  }

  async provisionPersonalAccount(input: {
    email: string;
    authCredentialRef: string;
    dateOfBirth: string;
    identity: PersonalSignupIdentity;
    betaInviteCode: string | null;
  }): Promise<ProvisionedAccount> {
    const user = this.newUser(input);
    await this.claimInviteOrThrow(input.betaInviteCode, user.id);
    this.users.byId.set(user.id, user);
    const personalProfileId = this.storeProfile(user, input.identity);
    return { user, personalProfileId, businessProfileId: null };
  }

  async provisionBusinessAccount(input: {
    email: string;
    authCredentialRef: string;
    dateOfBirth: string;
    identity: PersonalSignupIdentity;
    business: BusinessSignupDetails;
    betaInviteCode: string | null;
  }): Promise<ProvisionedAccount> {
    const user = this.newUser(input);
    await this.claimInviteOrThrow(input.betaInviteCode, user.id);
    this.users.byId.set(user.id, user);
    const personalProfileId = this.storeProfile(user, input.identity);
    const businessProfileId = randomUUID();
    this.businessProfiles.set(businessProfileId, {
      id: businessProfileId,
      ownerUserId: user.id,
      legalBusinessName: input.business.legalBusinessName.trim(),
      displayName: input.business.dbaName?.trim() || input.business.legalBusinessName.trim(),
      entityType: input.business.entityType.trim(),
      taxIdType: input.business.taxIdType.trim(),
      businessPhone: input.business.businessPhone?.trim() || null,
      businessAddress: { ...input.business.businessAddress },
      country: input.business.country.trim(),
      state: input.business.state.trim(),
    });
    return { user, personalProfileId, businessProfileId };
  }

  async syncVerifiedAuthEmail(userId: string, verifiedEmail: string): Promise<void> {
    const profile = this.personalProfiles.get(userId);
    if (!profile) return;
    const normalized = verifiedEmail.trim().toLowerCase();
    if (profile.preferredEmail === normalized && !profile.preferredEmailVerifiedAt) {
      profile.preferredEmailVerifiedAt = new Date();
    }
  }
}

export class InMemoryEmailVerificationTokenRepository implements EmailVerificationTokenRepository {
  private byId = new Map<string, EmailVerificationTokenRecord>();
  private byHash = new Map<string, string>();

  async insert(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<EmailVerificationTokenRecord> {
    const record: EmailVerificationTokenRecord = { id: randomUUID(), consumedAt: null, ...input };
    this.byId.set(record.id, record);
    this.byHash.set(input.tokenHash, record.id);
    return record;
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerificationTokenRecord | null> {
    const id = this.byHash.get(tokenHash);
    return id ? this.byId.get(id) ?? null : null;
  }

  async consume(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.consumedAt = new Date();
  }
}

export class InMemoryPasswordResetTokenRepository implements PasswordResetTokenRepository {
  private byId = new Map<string, PasswordResetTokenRecord>();
  private byHash = new Map<string, string>();

  async insert(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<PasswordResetTokenRecord> {
    const record: PasswordResetTokenRecord = { id: randomUUID(), consumedAt: null, ...input };
    this.byId.set(record.id, record);
    this.byHash.set(input.tokenHash, record.id);
    return record;
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRecord | null> {
    const id = this.byHash.get(tokenHash);
    return id ? this.byId.get(id) ?? null : null;
  }

  async consume(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.consumedAt = new Date();
  }
}

export class InMemoryEmailSender implements EmailSender {
  sent: { to: string; subject: string; body: string; ctaUrl?: string; ctaText?: string }[] = [];

  async send(input: { to: string; subject: string; body: string; ctaUrl?: string; ctaText?: string }): Promise<{ providerMessageId: string | null }> {
    this.sent.push(input);
    return { providerMessageId: null };
  }

  /** Extracts the verification/reset token from the last email sent to `to` (the link is `.../<path>?token=<token>`). */
  lastTokenFor(to: string): string | undefined {
    const email = [...this.sent].reverse().find((item) => item.to === to);
    return email?.body.match(/token=([\w-]+)/)?.[1];
  }
}

export class InMemoryAuditEventRepository implements AuditEventRepository {
  events: AuditEventRecord[] = [];
  private nextId = 1;

  async getLastEvent(): Promise<AuditEventRecord | null> {
    return this.events.at(-1) ?? null;
  }

  async insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord> {
    const stored: AuditEventRecord = { ...record, id: this.nextId++ };
    this.events.push(stored);
    return stored;
  }
}

export const TEST_PEPPER = "test-pepper-value";
export const TEST_SESSION_TTL_MS = 60 * 60 * 1000;
export const TEST_APP_URL = "http://localhost:3000";
/** A date of birth that is always >= 18 years old regardless of when tests run. */
export const TEST_ADULT_DATE_OF_BIRTH = "1990-01-01";

/**
 * Reads a cookie's value from a Response's Set-Cookie header(s). Route
 * handlers are typed to return the plain `Response` withErrorHandling
 * declares, so tests can't rely on NextResponse's `.cookies` accessor
 * without an unsafe cast — this reads the wire format instead, which is
 * also closer to what a real HTTP client would observe.
 */
export function readSetCookie(response: Response, name: string): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const rawCookies = headers.getSetCookie
    ? headers.getSetCookie()
    : [headers.get("set-cookie") ?? ""].filter(Boolean);
  for (const raw of rawCookies) {
    const [pair] = raw.split(";");
    const separatorIndex = pair?.indexOf("=") ?? -1;
    if (!pair || separatorIndex === -1) continue;
    const cookieName = pair.slice(0, separatorIndex);
    if (cookieName === name) return pair.slice(separatorIndex + 1);
  }
  return undefined;
}

export function createTestAuthService(
  sessionTtlMs: number = TEST_SESSION_TTL_MS,
  appUrl: string = TEST_APP_URL,
  options: { betaInvites?: BetaInviteRepository } = {},
) {
  const users = new InMemoryUserAccountRepository();
  const sessions = new InMemorySessionRepository();
  const accountProvisioning = new InMemoryAccountProvisioningRepository(users, options.betaInvites);
  const emailVerificationTokens = new InMemoryEmailVerificationTokenRepository();
  const passwordResetTokens = new InMemoryPasswordResetTokenRepository();
  const auditRepo = new InMemoryAuditEventRepository();
  const audit = new AuditService(auditRepo);
  const emailSender = new InMemoryEmailSender();
  const authService = new AuthService(
    users,
    sessions,
    accountProvisioning,
    emailVerificationTokens,
    passwordResetTokens,
    audit,
    emailSender,
    { pepper: TEST_PEPPER, sessionTtlMs, appUrl },
    accountProvisioning,
  );
  return {
    authService,
    users,
    sessions,
    accountProvisioning,
    emailVerificationTokens,
    passwordResetTokens,
    auditRepo,
    emailSender,
  };
}

/** A minimal, valid PersonalSignupIdentity — every signup test that doesn't specifically exercise identity/address validation can spread this. */
export const TEST_SIGNUP_IDENTITY: PersonalSignupIdentity = {
  firstName: "Jamie",
  middleName: null,
  lastName: "Rivera",
  contactPhone: "+1-555-0100",
  address: { line1: "1 Market St", line2: null, city: "San Francisco", state: "CA", postalCode: "94105", country: "US" },
};

/** A minimal, valid BusinessSignupDetails counterpart to TEST_SIGNUP_IDENTITY above. */
export const TEST_SIGNUP_BUSINESS: BusinessSignupDetails = {
  legalBusinessName: "Rivera Consulting LLC",
  dbaName: null,
  entityType: "LLC",
  businessPhone: "+1-555-0101",
  businessAddress: { line1: "500 Howard St", line2: null, city: "San Francisco", postalCode: "94105" },
  state: "CA",
  country: "US",
  taxIdType: "EIN",
};
