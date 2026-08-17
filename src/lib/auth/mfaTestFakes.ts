import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import type { SmsSender } from "@/lib/notify/smsSender";
import { MfaService } from "./mfaService";
import type {
  MfaChallengePurpose,
  MfaChallengeRecord,
  MfaChallengeRepository,
  MfaCredentialRecord,
  MfaCredentialRepository,
  MfaMethod,
  MfaServiceOptions,
  StepUpVerificationRepository,
} from "./mfaService";

/** Test-only in-memory doubles for MfaService, mirroring src/lib/auth/testFakes.ts's pattern. */

export class InMemoryMfaCredentialRepository implements MfaCredentialRepository {
  private byId = new Map<string, MfaCredentialRecord>();

  async insert(input: {
    userId: string;
    method: MfaMethod;
    secretRef: string | null;
    phoneRef: string | null;
  }): Promise<MfaCredentialRecord> {
    const record: MfaCredentialRecord = { id: randomUUID(), verifiedAt: null, disabledAt: null, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async findLatestByUserAndMethod(userId: string, method: MfaMethod): Promise<MfaCredentialRecord | null> {
    const matches = [...this.byId.values()].filter(
      (c) => c.userId === userId && c.method === method && !c.disabledAt,
    );
    return matches.at(-1) ?? null;
  }

  async findVerifiedByUserId(userId: string): Promise<MfaCredentialRecord[]> {
    return [...this.byId.values()].filter((c) => c.userId === userId && c.verifiedAt && !c.disabledAt);
  }

  async markVerified(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.verifiedAt = new Date();
  }

  async disable(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.disabledAt = new Date();
  }
}

export class InMemoryMfaChallengeRepository implements MfaChallengeRepository {
  private byId = new Map<string, MfaChallengeRecord>();

  async insert(input: {
    userId: string;
    method: MfaMethod;
    codeHash: string | null;
    purpose: MfaChallengePurpose;
    expiresAt: Date;
  }): Promise<MfaChallengeRecord> {
    const record: MfaChallengeRecord = { id: randomUUID(), consumedAt: null, attempts: 0, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async findLatestPending(
    userId: string,
    method: MfaMethod,
    purpose: MfaChallengePurpose,
  ): Promise<MfaChallengeRecord | null> {
    const matches = [...this.byId.values()].filter(
      (c) => c.userId === userId && c.method === method && c.purpose === purpose && !c.consumedAt,
    );
    return matches.at(-1) ?? null;
  }

  async incrementAttempts(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.attempts += 1;
  }

  async consume(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.consumedAt = new Date();
  }
}

export class InMemoryStepUpVerificationRepository implements StepUpVerificationRepository {
  private bySession = new Map<string, { expiresAt: Date }[]>();

  async insert(input: { sessionId: string; expiresAt: Date }): Promise<void> {
    const list = this.bySession.get(input.sessionId) ?? [];
    list.push({ expiresAt: input.expiresAt });
    this.bySession.set(input.sessionId, list);
  }

  async findActiveForSession(sessionId: string, now: Date): Promise<{ expiresAt: Date } | null> {
    const list = this.bySession.get(sessionId) ?? [];
    const active = list.filter((entry) => entry.expiresAt.getTime() > now.getTime());
    if (active.length === 0) return null;
    return active.reduce((latest, entry) => (entry.expiresAt > latest.expiresAt ? entry : latest));
  }
}

export class InMemorySmsSender implements SmsSender {
  sent: { to: string; body: string }[] = [];

  async send(input: { to: string; body: string }): Promise<{ providerMessageId: string | null }> {
    this.sent.push(input);
    return { providerMessageId: null };
  }

  lastCodeFor(to: string): string | undefined {
    const message = [...this.sent].reverse().find((item) => item.to === to);
    return message?.body.match(/code is (\d{6})/)?.[1];
  }
}

class InMemoryAuditEventRepositoryForMfa implements AuditEventRepository {
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

export function createTestMfaService(options: MfaServiceOptions = {}) {
  const credentials = new InMemoryMfaCredentialRepository();
  const challenges = new InMemoryMfaChallengeRepository();
  const stepUps = new InMemoryStepUpVerificationRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForMfa();
  const audit = new AuditService(auditRepo);
  const smsSender = new InMemorySmsSender();
  const mfaService = new MfaService(credentials, challenges, stepUps, audit, smsSender, options);
  return { mfaService, credentials, challenges, stepUps, auditRepo, smsSender };
}
