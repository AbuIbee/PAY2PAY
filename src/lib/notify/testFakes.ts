import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { EmailDeliveryError } from "./emailDeliveryError";
import type { EmailSender } from "./emailSender";
import { SmsDeliveryError } from "./smsDeliveryError";
import type { SmsSender } from "./smsSender";
import { NotificationService } from "./notificationService";
import type {
  NotificationChannel,
  NotificationEventRecord,
  NotificationEventRepository,
  NotificationPreferenceRepository,
  NotificationServiceOptions,
  SmsConsentRecord,
  SmsConsentRepository,
  SmsOptOutRepository,
  UserContactReader,
} from "./notificationService";

/** Test-only in-memory doubles for NotificationService, mirroring src/lib/payments/testFakes.ts's pattern. */

export class InMemoryNotificationEventRepository implements NotificationEventRepository {
  byId = new Map<string, NotificationEventRecord>();
  private byDedupeKey = new Map<string, string>();

  async insert(input: {
    recipientUserId: string;
    notificationType: string;
    channel: NotificationChannel;
    critical: boolean;
    dedupeKey: string | null;
    relatedPaymentAttemptId: string | null;
    relatedAgreementId: string | null;
    relatedInvitationId: string | null;
    payload: Record<string, unknown>;
  }): Promise<NotificationEventRecord> {
    const record: NotificationEventRecord = {
      id: randomUUID(),
      status: "pending",
      failureReason: null,
      attemptCount: 0,
      nextRetryAt: null,
      deliveredAt: null,
      sentAt: null,
      providerMessageId: null,
      createdAt: new Date(),
      readAt: null,
      archivedAt: null,
      ...input,
    };
    this.byId.set(record.id, record);
    if (input.dedupeKey) this.byDedupeKey.set(input.dedupeKey, record.id);
    return record;
  }

  async findById(id: string): Promise<NotificationEventRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findByDedupeKey(dedupeKey: string): Promise<NotificationEventRecord | null> {
    const id = this.byDedupeKey.get(dedupeKey);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async findByProviderMessageId(providerMessageId: string): Promise<NotificationEventRecord | null> {
    return [...this.byId.values()].find((r) => r.providerMessageId === providerMessageId) ?? null;
  }

  async markSent(id: string, input: { sentAt: Date; providerMessageId: string | null }): Promise<NotificationEventRecord> {
    const record = this.mustFind(id);
    record.status = "sent";
    record.sentAt = input.sentAt;
    record.providerMessageId = input.providerMessageId;
    record.failureReason = null;
    record.nextRetryAt = null;
    return record;
  }

  async markDelivered(id: string, deliveredAt: Date | null): Promise<NotificationEventRecord> {
    const record = this.mustFind(id);
    record.status = "delivered";
    record.deliveredAt = deliveredAt;
    record.failureReason = null;
    record.nextRetryAt = null;
    return record;
  }

  async markFailed(id: string, input: { failureReason: string; attemptCount: number; nextRetryAt: Date | null }): Promise<NotificationEventRecord> {
    const record = this.mustFind(id);
    record.status = "failed";
    record.failureReason = input.failureReason;
    record.attemptCount = input.attemptCount;
    record.nextRetryAt = input.nextRetryAt;
    return record;
  }

  async findDueForRetry(now: Date, maxAttempts: number): Promise<NotificationEventRecord[]> {
    return [...this.byId.values()].filter(
      (r) => r.status === "failed" && r.nextRetryAt !== null && r.nextRetryAt <= now && r.attemptCount < maxAttempts,
    );
  }

  async listForUser(recipientUserId: string): Promise<NotificationEventRecord[]> {
    return [...this.byId.values()]
      .filter((e) => e.recipientUserId === recipientUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async markRead(id: string, recipientUserId: string, readAt: Date): Promise<NotificationEventRecord | null> {
    const record = this.byId.get(id);
    if (!record || record.recipientUserId !== recipientUserId) return null;
    record.readAt = readAt;
    return record;
  }

  /** Mirrors DrizzleNotificationEventRepository.archiveGroup's own matching rule (bare id, or a shared dedupeKey/dedupeKey-prefix). */
  async archiveGroup(recipientUserId: string, groupId: string, archivedAt: Date): Promise<number> {
    let count = 0;
    for (const record of this.byId.values()) {
      if (record.recipientUserId !== recipientUserId) continue;
      const matches = record.id === groupId || record.dedupeKey === groupId || (record.dedupeKey?.startsWith(`${groupId}:`) ?? false);
      if (!matches) continue;
      record.archivedAt = archivedAt;
      count += 1;
    }
    return count;
  }

  async listRecentByChannel(channel: NotificationChannel, limit: number): Promise<NotificationEventRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.channel === channel)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  /** Mirrors DrizzleNotificationEventRepository.listReadyForAutoArchive's exact candidate filter. */
  async listReadyForAutoArchive(readBefore: Date): Promise<{ id: string; recipientUserId: string; dedupeKey: string | null }[]> {
    return [...this.byId.values()]
      .filter((r) => r.channel === "in_app" && r.archivedAt === null && r.readAt !== null && r.readAt <= readBefore)
      .map((r) => ({ id: r.id, recipientUserId: r.recipientUserId, dedupeKey: r.dedupeKey }));
  }

  private mustFind(id: string): NotificationEventRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("notification_event not found");
    return record;
  }
}

export class InMemoryNotificationPreferenceRepository implements NotificationPreferenceRepository {
  private byKey = new Map<string, boolean>();

  private key(userId: string, notificationType: string, channel: NotificationChannel): string {
    return `${userId}:${notificationType}:${channel}`;
  }

  async find(userId: string, notificationType: string, channel: NotificationChannel): Promise<{ enabled: boolean } | null> {
    const key = this.key(userId, notificationType, channel);
    return this.byKey.has(key) ? { enabled: this.byKey.get(key)! } : null;
  }

  async upsert(input: { userId: string; notificationType: string; channel: NotificationChannel; enabled: boolean }): Promise<void> {
    this.byKey.set(this.key(input.userId, input.notificationType, input.channel), input.enabled);
  }

  async listForUser(userId: string): Promise<{ notificationType: string; channel: NotificationChannel; enabled: boolean }[]> {
    const results: { notificationType: string; channel: NotificationChannel; enabled: boolean }[] = [];
    for (const [key, enabled] of this.byKey.entries()) {
      const [rowUserId, notificationType, channel] = key.split(":") as [string, string, NotificationChannel];
      if (rowUserId === userId) results.push({ notificationType, channel, enabled });
    }
    return results;
  }
}

export class InMemoryUserContactReader implements UserContactReader {
  private emailByUserId = new Map<string, string>();
  private phoneByUserId = new Map<string, string>();

  set(userId: string, email: string): void {
    this.emailByUserId.set(userId, email);
  }

  setPhone(userId: string, phone: string): void {
    this.phoneByUserId.set(userId, phone);
  }

  async getEmail(userId: string): Promise<string | null> {
    return this.emailByUserId.get(userId) ?? null;
  }

  async getPhone(userId: string): Promise<string | null> {
    return this.phoneByUserId.get(userId) ?? null;
  }
}

export class InMemoryEmailSender implements EmailSender {
  sent: { to: string; subject: string; body: string; ctaUrl?: string; ctaText?: string }[] = [];
  failNext = false;
  /** When set, the next simulated failure throws EmailDeliveryError with this retryable flag instead of a plain Error — lets tests exercise both the bounded-retry path and the immediate-dead-letter path. */
  failNextRetryable: boolean | null = null;
  private nextProviderMessageId: string | null = null;

  setNextProviderMessageId(id: string): void {
    this.nextProviderMessageId = id;
  }

  async send(input: { to: string; subject: string; body: string; ctaUrl?: string; ctaText?: string }): Promise<{ providerMessageId: string | null }> {
    if (this.failNext) {
      this.failNext = false;
      const retryable = this.failNextRetryable;
      this.failNextRetryable = null;
      if (retryable !== null) {
        throw new EmailDeliveryError("simulated_email_send_failure", { retryable, category: retryable ? "timeout" : "invalid_recipient" });
      }
      throw new Error("simulated_email_send_failure");
    }
    this.sent.push(input);
    const providerMessageId = this.nextProviderMessageId ?? randomUUID();
    this.nextProviderMessageId = null;
    return { providerMessageId };
  }
}

export class InMemorySmsSender implements SmsSender {
  sent: { to: string; body: string }[] = [];
  failNext = false;
  /** Mirrors InMemoryEmailSender's identical failNextRetryable convention. */
  failNextRetryable: boolean | null = null;
  private nextProviderMessageId: string | null = null;

  setNextProviderMessageId(id: string): void {
    this.nextProviderMessageId = id;
  }

  async send(input: { to: string; body: string }): Promise<{ providerMessageId: string | null }> {
    if (this.failNext) {
      this.failNext = false;
      const retryable = this.failNextRetryable;
      this.failNextRetryable = null;
      if (retryable !== null) {
        throw new SmsDeliveryError("simulated_sms_send_failure", { retryable, category: retryable ? "timeout" : "invalid_number" });
      }
      throw new Error("simulated_sms_send_failure");
    }
    this.sent.push(input);
    const providerMessageId = this.nextProviderMessageId ?? randomUUID();
    this.nextProviderMessageId = null;
    return { providerMessageId };
  }
}

export class InMemorySmsOptOutRepository implements SmsOptOutRepository {
  private opted = new Set<string>();

  async isOptedOut(phone: string): Promise<boolean> {
    return this.opted.has(phone);
  }

  async recordOptOut(phone: string, source: "stop_keyword" | "provider_rejection" = "stop_keyword"): Promise<void> {
    void source;
    this.opted.add(phone);
  }
}

/**
 * B0-B: in-memory double for the SMS consent gate. `find` returns `null` (no consent) for any userId
 * never explicitly touched — the real, mandatory default-off behavior — UNLESS `defaultActive` is set
 * at construction time (see `createTestNotificationService`'s own doc comment for why the shared,
 * generic test factory opts into that convenience rather than requiring every one of the dozens of
 * pre-existing, unrelated tests it already serves to separately grant SMS consent). `setActive` is a
 * raw test-only override, independent of `activate`/`withdraw`'s own audit-adjacent semantics, for
 * tests that need to force a specific state directly.
 */
/**
 * B0-B-001 correction: `defaultActive`'s synthesized record now resolves its `consentedPhoneE164` from
 * the same `contactsForDefault` reader the shared factory already constructs `contacts` from (passed
 * in by `createTestNotificationService`), so the permissive-default fixture stays internally
 * consistent with the new destination-equality rule — a test that calls `contacts.setPhone(userId, x)`
 * and relies on the default-active convenience gets a synthesized consent that genuinely covers `x`,
 * not a stale/unrelated placeholder phone that the new equality check would immediately reject. Tests
 * that specifically exercise phone-binding call `activate`/`setActive` explicitly instead, which are
 * unaffected by this default-synthesis path.
 */
export class InMemorySmsConsentRepository implements SmsConsentRepository {
  private byUserId = new Map<string, SmsConsentRecord>();

  constructor(
    private readonly defaultActive: boolean = false,
    private readonly contactsForDefault?: InMemoryUserContactReader,
  ) {}

  /** Test-only introspection — the number of userIds this fake has ever explicitly recorded a row for (never counts `defaultActive`'s synthesized responses, which are never persisted). Used to prove no consent row is ever fabricated for an unregistered invitation recipient. */
  get recordedCount(): number {
    return this.byUserId.size;
  }

  async find(userId: string): Promise<SmsConsentRecord | null> {
    const existing = this.byUserId.get(userId);
    if (existing) return existing;
    if (!this.defaultActive) return null;
    const phone = (await this.contactsForDefault?.getPhone(userId)) ?? null;
    return { userId, active: true, consentedPhoneE164: phone, consentedAt: new Date(0), withdrawnAt: null, source: "web_form", disclosureVersion: "test-default" };
  }

  async activate(userId: string, input: { source: string; disclosureVersion: string; consentedPhoneE164: string; at: Date }): Promise<SmsConsentRecord> {
    const record: SmsConsentRecord = {
      userId,
      active: true,
      consentedPhoneE164: input.consentedPhoneE164,
      consentedAt: input.at,
      withdrawnAt: null,
      source: input.source,
      disclosureVersion: input.disclosureVersion,
    };
    this.byUserId.set(userId, record);
    return record;
  }

  async withdraw(userId: string, at: Date): Promise<SmsConsentRecord> {
    const previous = this.byUserId.get(userId);
    const record: SmsConsentRecord = {
      userId,
      active: false,
      // Preserved (never cleared) — mirrors DrizzleSmsConsentRepository's identical real behavior.
      consentedPhoneE164: previous?.consentedPhoneE164 ?? null,
      consentedAt: previous?.consentedAt ?? null,
      withdrawnAt: at,
      source: previous?.source ?? null,
      disclosureVersion: previous?.disclosureVersion ?? null,
    };
    this.byUserId.set(userId, record);
    return record;
  }

  /** Test-only raw override — bypasses activate/withdraw's own field semantics entirely. Lets a test force an exact (active, consentedPhoneE164) pair directly, e.g. to simulate "consent still says active for the OLD phone" after a simulated phone change. */
  setActive(userId: string, active: boolean, consentedPhoneE164?: string | null): void {
    const previous = this.byUserId.get(userId);
    this.byUserId.set(userId, {
      userId,
      active,
      consentedPhoneE164: consentedPhoneE164 !== undefined ? consentedPhoneE164 : (previous?.consentedPhoneE164 ?? null),
      consentedAt: previous?.consentedAt ?? null,
      withdrawnAt: previous?.withdrawnAt ?? null,
      source: previous?.source ?? null,
      disclosureVersion: previous?.disclosureVersion ?? null,
    });
  }
}

class InMemoryAuditEventRepositoryForNotify implements AuditEventRepository {
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

/**
 * PRSprint 16, requirement #17: `audit`/`auditRepo` let tests assert on the preference-change audit
 * trail; both are optional to consume — most existing tests never touch them, so this is purely
 * additive.
 *
 * B0-B: `smsConsentDefaultActive` (default `true`) makes the returned `smsConsents` fake treat every
 * userId as already consented, purely so the dozens of pre-existing tests that already call this
 * shared, generic factory to exercise OTHER behavior (critical-type overrides, retry/backoff,
 * provider-status webhooks, etc.) via a phone+SMS setup keep testing exactly what they already test,
 * without each one separately granting SMS consent for a precondition unrelated to what it's actually
 * verifying. This is a test-fixture-only convenience — it has no bearing on production behavior, where
 * `DrizzleSmsConsentRepository.find` genuinely returns no row (and therefore `active: false`) for any
 * real user who has never touched the control, exactly as the mandatory default-off rule requires.
 * Tests that specifically exercise the consent gate itself pass `smsConsentDefaultActive: false`
 * explicitly (see notificationService.smsConsent.test.ts) to get the real, strict default.
 */
export function createTestNotificationService(options?: NotificationServiceOptions, appUrl: string = "https://app.test", smsConsentDefaultActive: boolean = true) {
  const events = new InMemoryNotificationEventRepository();
  const preferences = new InMemoryNotificationPreferenceRepository();
  const contacts = new InMemoryUserContactReader();
  const emailSender = new InMemoryEmailSender();
  const smsSender = new InMemorySmsSender();
  const smsOptOuts = new InMemorySmsOptOutRepository();
  const smsConsents = new InMemorySmsConsentRepository(smsConsentDefaultActive, contacts);
  const auditRepo = new InMemoryAuditEventRepositoryForNotify();
  const audit = new AuditService(auditRepo);
  const notificationService = new NotificationService({ events, preferences, emailSender, smsSender, contacts, smsOptOuts, smsConsents, appUrl, audit }, options);
  return { events, preferences, contacts, emailSender, smsSender, smsOptOuts, smsConsents, appUrl, auditRepo, audit, notificationService };
}
