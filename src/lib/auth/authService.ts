import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { AccountDisabledError, AuthenticationError, ConflictError, ValidationError } from "@/lib/errors";
import type { EmailSender } from "@/lib/notify/emailSender";
import { UNUSABLE_PASSWORD_HASH, hashPassword, verifyPassword } from "./password";
import { generateSessionToken, hashSessionToken } from "./session";
import { generateOpaqueToken, generatePublicReferenceCode, hashOpaqueToken } from "./token";

/** Sprint 6A (docs/sprints/SPRINT_06A_Platform_Administration_Audit_Control.md) platform authorization. */
export type PlatformRole = "member" | "platform_admin" | "platform_owner";
/** Sprint 6A: durable test/internal-account classification, independent of `status`. */
export type AccountClassification = "production" | "internal" | "qa" | "demo" | "automated_test";

export interface UserAccountRecord {
  id: string;
  email: string;
  authCredentialRef: string;
  status: string;
  platformRole: PlatformRole;
  accountClassification: AccountClassification;
  dateOfBirth: string | null;
  emailVerifiedAt: Date | null;
  /** Section K (closed-beta remediation): null only for a pre-existing row that hasn't been read via ensurePublicReference yet — every row inserted after this change gets one immediately. */
  publicReference: string | null;
}

/**
 * Storage abstraction AuthService writes through. Kept as an interface (like
 * AuditEventRepository in src/lib/audit/auditService.ts) so signup/login can
 * be unit-tested against an in-memory fake without a live database — see
 * src/lib/auth/authService.test.ts. Real implementation:
 * DrizzleUserAccountRepository.
 */
export interface UserAccountRepository {
  findByEmail(email: string): Promise<UserAccountRecord | null>;
  findById(id: string): Promise<UserAccountRecord | null>;
  insert(input: {
    email: string;
    authCredentialRef: string;
    dateOfBirth: string;
  }): Promise<UserAccountRecord>;
  markEmailVerified(userId: string): Promise<void>;
  updateLastLogin(userId: string): Promise<void>;
  updatePasswordHash(userId: string, authCredentialRef: string): Promise<void>;
  /** Sprint 6A: admin suspend/reactivate. */
  updateStatus(userId: string, status: string): Promise<void>;
  /** Sprint 6A: owner-only role administration. */
  updatePlatformRole(userId: string, platformRole: PlatformRole): Promise<void>;
  /** Sprint 6A: admin test-account classification. */
  updateAccountClassification(userId: string, accountClassification: AccountClassification): Promise<void>;
  /** Section K (closed-beta remediation): backfills a pre-existing row that has none — see AuthService.ensurePublicReference. */
  setPublicReference(userId: string, publicReference: string): Promise<void>;
  /** Section K: for admin search — case-sensitive exact match on the "P2P-XXXXXXXX" reference. */
  findByPublicReference(publicReference: string): Promise<UserAccountRecord | null>;
}

export interface PersonalProfileRecord {
  id: string;
  userId: string;
}

/**
 * Sprint 2 (docs/sprints/SPRINT_02_Authentication.md) account architecture:
 * every user gets exactly one personal profile, created alongside signup —
 * never client-specified, always derived from the just-created user's own
 * id (see AuthService.signup — there is no parameter through which a caller
 * could request a profile for a *different* user).
 */
export interface PersonalProfileRepository {
  insert(userId: string): Promise<PersonalProfileRecord>;
  findByUserId(userId: string): Promise<PersonalProfileRecord | null>;
}

export interface SessionRecord {
  id: string;
  userId: string;
  sessionTokenHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Real implementation: DrizzleSessionRepository. */
export interface SessionRepository {
  insert(input: {
    userId: string;
    sessionTokenHash: string;
    expiresAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<SessionRecord>;
  findByTokenHash(sessionTokenHash: string): Promise<SessionRecord | null>;
  /** PRSprint 06: session self-service (view/revoke) needs to look a session up by its own id, not just its token hash — the raw token is never sent back to the client after login, only the opaque session id. */
  findById(id: string): Promise<SessionRecord | null>;
  revoke(id: string): Promise<void>;
  /** Used by resetPassword: a successful password reset invalidates every existing session. */
  revokeAllForUser(userId: string): Promise<void>;
  touchLastSeen(id: string): Promise<void>;
  /** PRSprint 06 (docs/prsprints/PRSPRINT_06_AUTHENTICATION_SESSION_HARDENING.md): every non-revoked, non-expired session for a user, most recently active first — powers "Signed-in devices" self-service visibility. */
  listActiveForUser(userId: string, now: Date): Promise<SessionRecord[]>;
}

export interface EmailVerificationTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface EmailVerificationTokenRepository {
  insert(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<EmailVerificationTokenRecord>;
  findByTokenHash(tokenHash: string): Promise<EmailVerificationTokenRecord | null>;
  consume(id: string): Promise<void>;
}

export interface PasswordResetTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface PasswordResetTokenRepository {
  insert(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<PasswordResetTokenRecord>;
  findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRecord | null>;
  consume(id: string): Promise<void>;
}

export interface AuthServiceOptions {
  /** Server-only pepper mixed into every password hash (AUTH_PASSWORD_PEPPER). */
  pepper: string;
  /** How long a new session is valid for, in milliseconds. */
  sessionTtlMs: number;
  /** Base URL used to build the links inside verification/reset emails (APP_URL). */
  appUrl: string;
  emailVerificationTtlMs?: number;
  passwordResetTtlMs?: number;
}

export interface AuthActionContext {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface AuthResult {
  user: Pick<UserAccountRecord, "id" | "email">;
  token: string;
  expiresAt: Date;
}

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const MIN_AGE_YEARS = 18;
const DEFAULT_EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const DATE_OF_BIRTH_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function calculateAgeYears(dateOfBirthIso: string, now: Date): number {
  const dob = new Date(`${dateOfBirthIso}T00:00:00Z`);
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/**
 * Orchestrates auth: signup, login, logout, session validation, email
 * verification, and password reset. Every state-changing action is recorded
 * through AuditService (NFR-AUDIT-002 — writes go through the Audit
 * Service, not around it).
 */
export class AuthService {
  constructor(
    private readonly users: UserAccountRepository,
    private readonly sessions: SessionRepository,
    private readonly personalProfiles: PersonalProfileRepository,
    private readonly emailVerificationTokens: EmailVerificationTokenRepository,
    private readonly passwordResetTokens: PasswordResetTokenRepository,
    private readonly audit: AuditService,
    private readonly emailSender: EmailSender,
    private readonly options: AuthServiceOptions,
  ) {}

  async signup(input: {
    email: string;
    password: string;
    dateOfBirth: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    if (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > MAX_PASSWORD_LENGTH) {
      throw new ValidationError(
        `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`,
      );
    }
    if (!DATE_OF_BIRTH_PATTERN.test(input.dateOfBirth) || Number.isNaN(Date.parse(input.dateOfBirth))) {
      throw new ValidationError("A valid date of birth is required.");
    }
    if (calculateAgeYears(input.dateOfBirth, new Date()) < MIN_AGE_YEARS) {
      throw new ValidationError("You must be at least 18 years old to create an account.");
    }

    const existing = await this.users.findByEmail(email);
    if (existing) {
      throw new ConflictError("An account with this email already exists.");
    }

    const authCredentialRef = await hashPassword(input.password, this.options.pepper);
    const user = await this.users.insert({ email, authCredentialRef, dateOfBirth: input.dateOfBirth });

    // Never client-specified — always the id of the user just created above.
    await this.personalProfiles.insert(user.id);

    await this.audit.record({
      actorUserId: user.id,
      actorRole: "personal_user",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action: "user_signup",
      occurredAt: new Date().toISOString(),
      ipAddress: input.ipAddress,
      deviceInfo: input.userAgent ? { userAgent: input.userAgent } : null,
      previousValue: null,
      newValue: { email: user.email },
      reason: null,
      authStrength: "basic",
      relatedDocumentId: null,
      relatedCaseId: null,
    });

    await this.sendVerificationEmail(user);

    return this.createSession(user, input);
  }

  /**
   * Section K (closed-beta remediation, Product Owner review): every row inserted after this change
   * gets a `publicReference` immediately (see UserAccountRepository.insert's real implementation),
   * but a pre-existing row has none yet — this generates and persists one on first read rather than
   * requiring a blocking data migration against every existing row up front. Idempotent: returns the
   * existing value untouched if one is already set.
   */
  async ensurePublicReference(userId: string): Promise<string> {
    const user = await this.users.findById(userId);
    if (!user) throw new ValidationError("User not found.");
    if (user.publicReference) return user.publicReference;
    const publicReference = generatePublicReferenceCode();
    await this.users.setPublicReference(userId, publicReference);
    return publicReference;
  }

  /** Authenticated resend — deliberately not a public email-lookup endpoint (avoids an enumeration surface). */
  async resendVerificationEmail(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new AuthenticationError("A valid session is required.");
    if (user.emailVerifiedAt) return; // already verified — quietly no-ops
    await this.sendVerificationEmail(user);
  }

  private async sendVerificationEmail(user: UserAccountRecord): Promise<void> {
    const rawToken = generateOpaqueToken();
    const expiresAt = new Date(
      Date.now() + (this.options.emailVerificationTtlMs ?? DEFAULT_EMAIL_VERIFICATION_TTL_MS),
    );
    await this.emailVerificationTokens.insert({
      userId: user.id,
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt,
    });
    const link = `${this.options.appUrl}/verify-email?token=${rawToken}`;
    await this.emailSender.send({
      to: user.email,
      subject: "Verify your PAY2PAY email address",
      body: `Confirm your email address: ${link}\n\nThis link expires in 24 hours. If you didn't create a PAY2PAY account, you can ignore this email.`,
    });
  }

  async verifyEmail(rawToken: string): Promise<void> {
    const record = await this.emailVerificationTokens.findByTokenHash(hashOpaqueToken(rawToken));
    if (!record || record.consumedAt || record.expiresAt.getTime() <= Date.now()) {
      throw new ValidationError("This verification link is invalid or has expired.");
    }
    await this.emailVerificationTokens.consume(record.id);
    await this.users.markEmailVerified(record.userId);
    await this.audit.record({
      actorUserId: record.userId,
      actorRole: "personal_user",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action: "email_verified",
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: null,
      reason: null,
      authStrength: "basic",
      relatedDocumentId: null,
      relatedCaseId: null,
    });
  }

  async login(input: {
    email: string;
    password: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    const user = await this.users.findByEmail(email);

    // Verify against a real (if found) or a fixed unusable hash (if not) so
    // "no such account" and "wrong password" take equivalent time and both
    // fail identically — prevents timing-based account enumeration.
    const isValid = await verifyPassword(
      input.password,
      this.options.pepper,
      user?.authCredentialRef ?? UNUSABLE_PASSWORD_HASH,
    );

    if (!user || !isValid) {
      await this.audit.record({
        actorUserId: user?.id ?? null,
        actorRole: "personal_user",
        profileKind: null,
        profileId: null,
        agreementId: null,
        action: "login_failed",
        occurredAt: new Date().toISOString(),
        ipAddress: input.ipAddress,
        deviceInfo: input.userAgent ? { userAgent: input.userAgent } : null,
        previousValue: null,
        newValue: null,
        reason: null,
        authStrength: "basic",
        relatedDocumentId: null,
        relatedCaseId: null,
      });
      throw new AuthenticationError("Invalid email or password.");
    }

    if (user.status !== "active") {
      // Only reached after a *correct* password — safe to be specific
      // without creating an account-enumeration signal (see AccountDisabledError's doc comment).
      await this.audit.record({
        actorUserId: user.id,
        actorRole: "personal_user",
        profileKind: null,
        profileId: null,
        agreementId: null,
        action: "login_blocked_account_disabled",
        occurredAt: new Date().toISOString(),
        ipAddress: input.ipAddress,
        deviceInfo: input.userAgent ? { userAgent: input.userAgent } : null,
        previousValue: null,
        newValue: null,
        reason: null,
        authStrength: "basic",
        relatedDocumentId: null,
        relatedCaseId: null,
      });
      throw new AccountDisabledError();
    }

    await this.users.updateLastLogin(user.id);
    return this.createSession(user, input);
  }

  async logout(token: string): Promise<void> {
    const session = await this.sessions.findByTokenHash(hashSessionToken(token));
    if (!session || session.revokedAt) {
      throw new AuthenticationError("No active session.");
    }
    await this.sessions.revoke(session.id);
    await this.audit.record({
      actorUserId: session.userId,
      actorRole: "personal_user",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action: "logout",
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: null,
      reason: null,
      authStrength: "basic",
      relatedDocumentId: null,
      relatedCaseId: null,
    });
  }

  /**
   * Always resolves without revealing whether `email` belongs to an
   * account — enumeration resistance for the public "forgot password" entry
   * point (unlike resendVerificationEmail, which is authenticated).
   */
  async requestPasswordReset(email: string, context: AuthActionContext): Promise<void> {
    const normalized = normalizeEmail(email);
    const user = await this.users.findByEmail(normalized);

    await this.audit.record({
      actorUserId: user?.id ?? null,
      actorRole: "personal_user",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action: user ? "password_reset_requested" : "password_reset_requested_unknown_email",
      occurredAt: new Date().toISOString(),
      ipAddress: context.ipAddress,
      deviceInfo: context.userAgent ? { userAgent: context.userAgent } : null,
      previousValue: null,
      newValue: null,
      reason: null,
      authStrength: "basic",
      relatedDocumentId: null,
      relatedCaseId: null,
    });

    if (!user) return;

    const rawToken = generateOpaqueToken();
    const expiresAt = new Date(
      Date.now() + (this.options.passwordResetTtlMs ?? DEFAULT_PASSWORD_RESET_TTL_MS),
    );
    await this.passwordResetTokens.insert({ userId: user.id, tokenHash: hashOpaqueToken(rawToken), expiresAt });
    const link = `${this.options.appUrl}/reset-password?token=${rawToken}`;
    await this.emailSender.send({
      to: user.email,
      subject: "Reset your PAY2PAY password",
      body: `Reset your password: ${link}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email — your password will not be changed.`,
    });
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
      throw new ValidationError(
        `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`,
      );
    }
    const record = await this.passwordResetTokens.findByTokenHash(hashOpaqueToken(rawToken));
    if (!record || record.consumedAt || record.expiresAt.getTime() <= Date.now()) {
      throw new ValidationError("This password reset link is invalid or has expired.");
    }

    const authCredentialRef = await hashPassword(newPassword, this.options.pepper);
    await this.users.updatePasswordHash(record.userId, authCredentialRef);
    await this.passwordResetTokens.consume(record.id);
    // A password reset invalidates every existing session, including
    // whichever one an attacker may have established with the old password.
    await this.sessions.revokeAllForUser(record.userId);

    await this.audit.record({
      actorUserId: record.userId,
      actorRole: "personal_user",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action: "password_reset_completed",
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: null,
      reason: null,
      authStrength: "basic",
      relatedDocumentId: null,
      relatedCaseId: null,
    });
  }

  /**
   * PRSprint 06 (docs/prsprints/PRSPRINT_06_AUTHENTICATION_SESSION_HARDENING.md): "Device/session
   * visibility" — every active session belonging to `userId`, never another user's (there is no
   * parameter through which a caller could request someone else's sessions; the id always comes
   * from the trusted, DB-sourced identity `requireSession` resolved, never client input).
   */
  async listSessions(userId: string): Promise<SessionRecord[]> {
    return this.sessions.listActiveForUser(userId, new Date());
  }

  /**
   * Revokes exactly one of the caller's own sessions. Deliberately throws the same
   * AuthenticationError for "no such session", "already revoked", and "belongs to a different
   * user" — an IDOR attempt (guessing another user's session id) gets no signal distinguishing it
   * from a typo, mirroring login's account-enumeration resistance.
   */
  async revokeSession(userId: string, sessionId: string, context: AuthActionContext): Promise<void> {
    const session = await this.sessions.findById(sessionId);
    if (!session || session.userId !== userId || session.revokedAt) {
      throw new AuthenticationError("This session could not be found.");
    }
    await this.sessions.revoke(sessionId);
    await this.audit.record({
      actorUserId: userId,
      actorRole: "personal_user",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action: "session_revoked_self",
      occurredAt: new Date().toISOString(),
      ipAddress: context.ipAddress,
      deviceInfo: context.userAgent ? { userAgent: context.userAgent } : null,
      previousValue: null,
      newValue: null,
      reason: null,
      authStrength: "basic",
      relatedDocumentId: null,
      relatedCaseId: null,
    });
  }

  /**
   * "Log out everywhere" — revokes every session for `userId`, including whichever session the
   * caller is currently using (matching PRSprint 06's literal scope wording). The route calling
   * this is responsible for also clearing the caller's own session cookie, since the session this
   * request authenticated with is revoked too.
   */
  async revokeAllSessions(userId: string, context: AuthActionContext): Promise<void> {
    await this.sessions.revokeAllForUser(userId);
    await this.audit.record({
      actorUserId: userId,
      actorRole: "personal_user",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action: "logout_all_sessions",
      occurredAt: new Date().toISOString(),
      ipAddress: context.ipAddress,
      deviceInfo: context.userAgent ? { userAgent: context.userAgent } : null,
      previousValue: null,
      newValue: null,
      reason: null,
      authStrength: "basic",
      relatedDocumentId: null,
      relatedCaseId: null,
    });
  }

  /**
   * Resolves a raw session token to its user, or null if the token is
   * missing, unknown, expired, or revoked. Used by protected routes
   * (e.g. GET /api/auth/me) as the single session-validation seam.
   */
  async validateSession(
    token: string,
  ): Promise<{ user: Pick<UserAccountRecord, "id" | "email" | "platformRole">; sessionId: string } | null> {
    const session = await this.sessions.findByTokenHash(hashSessionToken(token));
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;

    const user = await this.users.findById(session.userId);
    if (!user) return null;
    // Sprint 6A defense in depth: a suspension must take effect immediately, not only at the next
    // login — a session created before suspension must stop working on its very next use, without
    // relying solely on the admin action also revoking sessions (which it does, but this closes the
    // gap if that step is ever skipped or races).
    if (user.status !== "active") return null;

    await this.sessions.touchLastSeen(session.id);
    return { user: { id: user.id, email: user.email, platformRole: user.platformRole }, sessionId: session.id };
  }

  private async createSession(
    user: UserAccountRecord,
    context: AuthActionContext,
  ): Promise<AuthResult> {
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + this.options.sessionTtlMs);
    await this.sessions.insert({
      userId: user.id,
      sessionTokenHash: hashSessionToken(token),
      expiresAt,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    await this.audit.record({
      actorUserId: user.id,
      actorRole: "personal_user",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action: "login_succeeded",
      occurredAt: new Date().toISOString(),
      ipAddress: context.ipAddress,
      deviceInfo: context.userAgent ? { userAgent: context.userAgent } : null,
      previousValue: null,
      newValue: null,
      reason: null,
      authStrength: "basic",
      relatedDocumentId: null,
      relatedCaseId: null,
    });

    return { user: { id: user.id, email: user.email }, token, expiresAt };
  }
}
