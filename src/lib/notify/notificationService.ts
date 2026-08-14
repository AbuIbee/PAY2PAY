import "server-only";
import type { EmailSender } from "./emailSender";
import type { SmsSender } from "./smsSender";
import { DEFAULT_CHANNELS, isCriticalNotificationType, type NotificationEventType } from "./eventTypes";
import { NOTIFICATION_TEMPLATES } from "./templates";

export type NotificationChannel = "email" | "sms" | "in_app";
export type NotificationStatus = "pending" | "sent" | "delivered" | "failed";

export interface NotificationEventRecord {
  id: string;
  recipientUserId: string;
  notificationType: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  critical: boolean;
  dedupeKey: string | null;
  relatedPaymentAttemptId: string | null;
  relatedAgreementId: string | null;
  payload: Record<string, unknown>;
  failureReason: string | null;
  attemptCount: number;
  nextRetryAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  /** Sprint 18B: null means unread — the Notification Center's read/unread state. */
  readAt: Date | null;
}

/** Real implementation: DrizzleNotificationEventRepository. */
export interface NotificationEventRepository {
  insert(input: {
    recipientUserId: string;
    notificationType: string;
    channel: NotificationChannel;
    critical: boolean;
    dedupeKey: string | null;
    relatedPaymentAttemptId: string | null;
    relatedAgreementId: string | null;
    payload: Record<string, unknown>;
  }): Promise<NotificationEventRecord>;
  findById(id: string): Promise<NotificationEventRecord | null>;
  findByDedupeKey(dedupeKey: string): Promise<NotificationEventRecord | null>;
  markDelivered(id: string, deliveredAt: Date | null): Promise<NotificationEventRecord>;
  markFailed(id: string, input: { failureReason: string; attemptCount: number; nextRetryAt: Date | null }): Promise<NotificationEventRecord>;
  /** Cron-scan entry point — a periodic/administrative operation, not a per-request hot path, mirroring PaymentAttemptRepository.listAll's precedent. */
  findDueForRetry(now: Date, maxAttempts: number): Promise<NotificationEventRecord[]>;
  listForUser(recipientUserId: string): Promise<NotificationEventRecord[]>;
  /** Sprint 18B: no-op if already read. Scoping to recipientUserId (not just id) is the authorization boundary — a user can never mark another user's notification read. */
  markRead(id: string, recipientUserId: string, readAt: Date): Promise<NotificationEventRecord | null>;
}

/** Real implementation: DrizzleNotificationPreferenceRepository. */
export interface NotificationPreferenceRepository {
  find(userId: string, notificationType: string, channel: NotificationChannel): Promise<{ enabled: boolean } | null>;
  upsert(input: { userId: string; notificationType: string; channel: NotificationChannel; enabled: boolean }): Promise<void>;
  listForUser(userId: string): Promise<{ notificationType: string; channel: NotificationChannel; enabled: boolean }[]>;
}

/** Real implementation: DrizzleUserContactReader (queries user_account.email/phone directly). */
export interface UserContactReader {
  getEmail(userId: string): Promise<string | null>;
  getPhone(userId: string): Promise<string | null>;
}

export interface NotificationServiceOptions {
  /** How long to wait before retrying a failed delivery. Default 15 minutes. */
  retryDelayMs?: number;
  /** Maximum delivery attempts (the original send plus this many retries) before giving up. Default 3. */
  maxAttempts?: number;
}

const DEFAULT_RETRY_DELAY_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Sprint 13's minimal internal notification primitive, extended per
 * docs/sprints/SPRINT_17_Notifications.md into full multi-channel delivery. `notify` is the only way
 * any notification is ever created — there is no route or caller that lets an arbitrary user compose
 * and send free-text to another user ("No unrestricted chat," this sprint's own instruction, verbatim,
 * enforced by construction: this class has no method that accepts caller-supplied subject/body text,
 * only a fixed `notificationType` rendered through `NOTIFICATION_TEMPLATES`).
 *
 * One `notify()` call fans out into one `notification_event` row per applicable channel (that event
 * type's default set — `eventTypes.ts` — filtered by the recipient's own preference, unless the type
 * is critical). "Critical notifications cannot be disabled" is structural, not a runtime check that
 * could be bypassed: `resolveChannels` never calls `preferences.find` at all for a critical type, so
 * there is no code path where a preference row — however it got created — can suppress one.
 *
 * Delivery dedup: a caller-supplied `dedupeKey` (e.g. `payment_failed:{paymentAttemptId}`) is combined
 * with the channel to form each row's own unique key; a second `notify()` call with the same key
 * returns the existing rows instead of sending again, mirroring `payment_attempt.idempotency_key`'s
 * identical Sprint 9 precedent — this is what makes a webhook or workflow retry safe to call again.
 */
export class NotificationService {
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly deps: {
      events: NotificationEventRepository;
      preferences: NotificationPreferenceRepository;
      emailSender: EmailSender;
      smsSender: SmsSender;
      contacts: UserContactReader;
    },
    options: NotificationServiceOptions = {},
  ) {
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async notify(input: {
    recipientUserId: string;
    notificationType: NotificationEventType;
    relatedPaymentAttemptId?: string | null;
    relatedAgreementId?: string | null;
    payload: Record<string, unknown>;
    dedupeKey?: string;
  }): Promise<NotificationEventRecord[]> {
    const critical = isCriticalNotificationType(input.notificationType);
    const channels = await this.resolveChannels(input.recipientUserId, input.notificationType, critical);
    const rendered = NOTIFICATION_TEMPLATES[input.notificationType](input.payload);

    const records: NotificationEventRecord[] = [];
    for (const channel of channels) {
      const channelDedupeKey = input.dedupeKey ? `${input.dedupeKey}:${channel}` : null;
      if (channelDedupeKey) {
        const existing = await this.deps.events.findByDedupeKey(channelDedupeKey);
        if (existing) {
          records.push(existing);
          continue;
        }
      }
      const record = await this.deps.events.insert({
        recipientUserId: input.recipientUserId,
        notificationType: input.notificationType,
        channel,
        critical,
        dedupeKey: channelDedupeKey,
        relatedPaymentAttemptId: input.relatedPaymentAttemptId ?? null,
        relatedAgreementId: input.relatedAgreementId ?? null,
        payload: input.payload,
      });
      records.push(await this.deliver(record, rendered));
    }
    return records;
  }

  /** Cron-firing entry point (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md's established "background job/scheduler abstraction" precedent). Redelivers each due, failed notification, re-rendering its template from the stored payload. */
  async retryDueNotifications(now: Date = new Date()): Promise<{ retried: number; succeeded: number; failed: number }> {
    const due = await this.deps.events.findDueForRetry(now, this.maxAttempts);
    let succeeded = 0;
    let failed = 0;
    for (const record of due) {
      const type = record.notificationType as NotificationEventType;
      const template = NOTIFICATION_TEMPLATES[type];
      const rendered = template ? template(record.payload) : { subject: "Notification", emailBody: "", smsBody: "", inAppBody: "" };
      const result = await this.deliver(record, rendered);
      if (result.status === "failed") failed++;
      else succeeded++;
    }
    return { retried: due.length, succeeded, failed };
  }

  async getPreferences(userId: string): Promise<{ notificationType: string; channel: NotificationChannel; enabled: boolean }[]> {
    return this.deps.preferences.listForUser(userId);
  }

  async setPreference(input: { userId: string; notificationType: NotificationEventType; channel: NotificationChannel; enabled: boolean }): Promise<void> {
    if (isCriticalNotificationType(input.notificationType)) {
      // "Critical notifications cannot be disabled" — silently ignoring an attempted opt-out (rather
      // than throwing) keeps this endpoint safe to call generically from a "toggle everything" UI
      // without every caller needing to special-case the critical list; resolveChannels never reads
      // this table for a critical type regardless, so a stored row here would be inert anyway.
      return;
    }
    await this.deps.preferences.upsert({
      userId: input.userId,
      notificationType: input.notificationType,
      channel: input.channel,
      enabled: input.enabled,
    });
  }

  async listForUser(recipientUserId: string): Promise<NotificationEventRecord[]> {
    return this.deps.events.listForUser(recipientUserId);
  }

  async markRead(recipientUserId: string, notificationId: string): Promise<NotificationEventRecord | null> {
    return this.deps.events.markRead(notificationId, recipientUserId, new Date());
  }

  private async resolveChannels(userId: string, type: NotificationEventType, critical: boolean): Promise<NotificationChannel[]> {
    const defaults = DEFAULT_CHANNELS[type];
    if (critical) return [...defaults];

    const channels: NotificationChannel[] = [];
    for (const channel of defaults) {
      const preference = await this.deps.preferences.find(userId, type, channel);
      if (!preference || preference.enabled) channels.push(channel);
    }
    return channels;
  }

  private async deliver(
    record: NotificationEventRecord,
    rendered: { subject: string; emailBody: string; smsBody: string; inAppBody: string },
  ): Promise<NotificationEventRecord> {
    try {
      if (record.channel === "in_app") {
        return this.deps.events.markDelivered(record.id, new Date());
      }
      if (record.channel === "email") {
        const email = await this.deps.contacts.getEmail(record.recipientUserId);
        if (!email) return record; // no contact info on file — recorded, left pending, not a failure.
        await this.deps.emailSender.send({ to: email, subject: rendered.subject, body: rendered.emailBody });
        return this.deps.events.markDelivered(record.id, new Date());
      }
      // sms
      const phone = await this.deps.contacts.getPhone(record.recipientUserId);
      if (!phone) return record;
      await this.deps.smsSender.send({ to: phone, body: rendered.smsBody });
      return this.deps.events.markDelivered(record.id, new Date());
    } catch (error) {
      const attemptCount = record.attemptCount + 1;
      const exhausted = attemptCount >= this.maxAttempts;
      return this.deps.events.markFailed(record.id, {
        failureReason: error instanceof Error ? error.message : "unknown_delivery_error",
        attemptCount,
        nextRetryAt: exhausted ? null : new Date(Date.now() + this.retryDelayMs),
      });
    }
  }
}
