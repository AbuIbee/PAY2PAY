import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { AuthenticationError, ConflictError } from "@/lib/errors";
import { UNUSABLE_PASSWORD_HASH, hashPassword, verifyPassword } from "./password";
import { generateSessionToken, hashSessionToken } from "./session";

export interface UserAccountRecord {
  id: string;
  email: string;
  authCredentialRef: string;
  status: string;
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
  insert(input: { email: string; authCredentialRef: string }): Promise<UserAccountRecord>;
}

export interface SessionRecord {
  id: string;
  userId: string;
  sessionTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
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
  revoke(id: string): Promise<void>;
  touchLastSeen(id: string): Promise<void>;
}

export interface AuthServiceOptions {
  /** Server-only pepper mixed into every password hash (AUTH_PASSWORD_PEPPER). */
  pepper: string;
  /** How long a new session is valid for, in milliseconds. */
  sessionTtlMs: number;
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Orchestrates Phase 0 basic auth: signup, login, logout, and session
 * validation. Every state-changing action is recorded through AuditService
 * (NFR-AUDIT-002 — writes go through the Audit Service, not around it),
 * mirroring the single-write-path pattern AuditService itself documents.
 */
export class AuthService {
  constructor(
    private readonly users: UserAccountRepository,
    private readonly sessions: SessionRepository,
    private readonly audit: AuditService,
    private readonly options: AuthServiceOptions,
  ) {}

  async signup(input: {
    email: string;
    password: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    if (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > MAX_PASSWORD_LENGTH) {
      throw new AuthenticationError(
        `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`,
      );
    }

    const existing = await this.users.findByEmail(email);
    if (existing) {
      throw new ConflictError("An account with this email already exists.");
    }

    const authCredentialRef = await hashPassword(input.password, this.options.pepper);
    const user = await this.users.insert({ email, authCredentialRef });

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

    return this.createSession(user, input);
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
   * Resolves a raw session token to its user, or null if the token is
   * missing, unknown, expired, or revoked. Used by protected routes
   * (e.g. GET /api/auth/me) as the single session-validation seam.
   */
  async validateSession(
    token: string,
  ): Promise<{ user: Pick<UserAccountRecord, "id" | "email">; sessionId: string } | null> {
    const session = await this.sessions.findByTokenHash(hashSessionToken(token));
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;

    const user = await this.users.findById(session.userId);
    if (!user) return null;

    await this.sessions.touchLastSeen(session.id);
    return { user: { id: user.id, email: user.email }, sessionId: session.id };
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
