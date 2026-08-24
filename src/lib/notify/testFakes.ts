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

  async listRecentByChannel(channel: NotificationChannel, limit: number): Promise<NotificationEventRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.channel === channel)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
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

/** PRSprint 16, requirement #17: `audit`/`auditRepo` let tests assert on the preference-change audit trail; both are optional to consume — most existing tests never touch them, so this is purely additive. */
export function createTestNotificationService(options?: NotificationServiceOptions) {
  const events = new InMemoryNotificationEventRepository();
  const preferences = new InMemoryNotificationPreferenceRepository();
  const contacts = new InMemoryUserContactReader();
  const emailSender = new InMemoryEmailSender();
  const smsSender = new InMemorySmsSender();
  const smsOptOuts = new InMemorySmsOptOutRepository();
  const appUrl = "https://app.test";
  const auditRepo = new InMemoryAuditEventRepositoryForNotify();
  const audit = new AuditService(auditRepo);
  const notificationService = new NotificationService({ events, preferences, emailSender, smsSender, contacts, smsOptOuts, appUrl, audit }, options);
  return { events, preferences, contacts, emailSender, smsSender, smsOptOuts, appUrl, auditRepo, audit, notificationService };
}
