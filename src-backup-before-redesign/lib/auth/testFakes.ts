import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { AuthService } from "./authService";
import type {
  SessionRecord,
  SessionRepository,
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
  private byId = new Map<string, UserAccountRecord>();

  async findByEmail(email: string): Promise<UserAccountRecord | null> {
    for (const user of this.byId.values()) {
      if (user.email === email) return user;
    }
    return null;
  }

  async findById(id: string): Promise<UserAccountRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async insert(input: { email: string; authCredentialRef: string }): Promise<UserAccountRecord> {
    const user: UserAccountRecord = {
      id: randomUUID(),
      email: input.email,
      authCredentialRef: input.authCredentialRef,
      status: "active",
    };
    this.byId.set(user.id, user);
    return user;
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
    const session: SessionRecord = {
      id: randomUUID(),
      userId: input.userId,
      sessionTokenHash: input.sessionTokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
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

  async revoke(id: string): Promise<void> {
    const session = this.byId.get(id);
    if (session) session.revokedAt = new Date();
  }

  async touchLastSeen(): Promise<void> {
    // No last-seen assertions in these tests; no-op is sufficient.
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

export function createTestAuthService(sessionTtlMs: number = TEST_SESSION_TTL_MS) {
  const users = new InMemoryUserAccountRepository();
  const sessions = new InMemorySessionRepository();
  const auditRepo = new InMemoryAuditEventRepository();
  const audit = new AuditService(auditRepo);
  const authService = new AuthService(users, sessions, audit, {
    pepper: TEST_PEPPER,
    sessionTtlMs,
  });
  return { authService, users, sessions, auditRepo };
}
