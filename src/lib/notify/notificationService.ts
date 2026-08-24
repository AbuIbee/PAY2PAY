import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { maskPhone } from "@/lib/phone";
import { EmailDeliveryError } from "./emailDeliveryError";
import type { EmailSender } from "./emailSender";
import { SmsDeliveryError } from "./smsDeliveryError";
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
  relatedInvitationId: string | null;
  payload: Record<string, unknown>;
  failureReason: string | null;
  attemptCount: number;
  nextRetryAt: Date | null;
  /** PRSprint 14: when the provider *confirmed actual delivery* via webhook — see `sentAt` for when the provider merely accepted the send. Still used as-is (on insert) for the `in_app` channel, where existing is delivery. */
  deliveredAt: Date | null;
  /** PRSprint 14 (docs/prsprints/PRSPRINT_14_PRODUCTION_EMAIL.md): when the email provider accepted the send. Null for channels/rows that never reached this state (in_app never sets it; sms doesn't use it yet — PRSprint 15). */
  sentAt: Date | null;
  /** The provider's own message id (e.g. Resend's `id`), used to correlate an inbound delivery webhook back to this row. Null until a real provider send succeeds. */
  providerMessageId: string | null;
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
    relatedInvitationId: string | null;
    payload: Record<string, unknown>;
  }): Promise<NotificationEventRecord>;
  findById(id: string): Promise<NotificationEventRecord | null>;
  findByDedupeKey(dedupeKey: string): Promise<NotificationEventRecord | null>;
  markDelivered(id: string, deliveredAt: Date | null): Promise<NotificationEventRecord>;
  markFailed(id: string, input: { failureReason: string; attemptCount: number; nextRetryAt: Date | null }): Promise<NotificationEventRecord>;
  /** PRSprint 14: the email-specific success state — provider *accepted* the send, not yet confirmed delivered. See `markDelivered` for the latter, now driven only by a verified provider webhook. */
  markSent(id: string, input: { sentAt: Date; providerMessageId: string | null }): Promise<NotificationEventRecord>;
  /** PRSprint 14: how the delivery webhook (POST /api/webhooks/email/resend) correlates a provider event back to the row it belongs to. */
  findByProviderMessageId(providerMessageId: string): Promise<NotificationEventRecord | null>;
  /** Cron-scan entry point — a periodic/administrative operation, not a per-request hot path, mirroring PaymentAttemptRepository.listAll's precedent. */
  findDueForRetry(now: Date, maxAttempts: number): Promise<NotificationEventRecord[]>;
  listForUser(recipientUserId: string): Promise<NotificationEventRecord[]>;
  /** Sprint 18B: no-op if already read. Scoping to recipientUserId (not just id) is the authorization boundary — a user can never mark another user's notification read. */
  markRead(id: string, recipientUserId: string, readAt: Date): Promise<NotificationEventRecord | null>;
  /** PRSprint 14: admin-facing operational visibility (src/lib/admin/emailDeliveryAdminService.ts) — every channel, most-recent-first, capped by `limit`. Not scoped to one recipient (that's `listForUser`'s job); scoped instead by the admin capability gate in front of it. */
  listRecentByChannel(channel: NotificationChannel, limit: number): Promise<NotificationEventRecord[]>;
}

/** Real implementation: DrizzleNotificationPreferenceRepository. */
export interface NotificationPreferenceRepository {
  find(userId: string, notificationType: string, channel: NotificationChannel): Promise<{ enabled: boolean } | null>;
  upsert(input: { userId: string; notificationType: string; channel: NotificationChannel; enabled: boolean }): Promise<void>;
  listForUser(userId: string): Promise<{ notificationType: string; channel: NotificationChannel; enabled: boolean }[]>;
}

/** Real implementation: DrizzleUserContactReader (queries user_account.email directly; the phone lookup resolves through a verified SMS MFA credential — see that class's own doc comment). */
export interface UserContactReader {
  getEmail(userId: string): Promise<string | null>;
  getPhone(userId: string): Promise<string | null>;
}

/** Real implementation: DrizzleSmsOptOutRepository. Keyed by the E.164 phone number itself, not a user id — see src/db/schema/smsOptOut.ts's own doc comment for why. */
export interface SmsOptOutRepository {
  isOptedOut(phone: string): Promise<boolean>;
  recordOptOut(phone: string, source: "stop_keyword" | "provider_rejection"): Promise<void>;
}

/**
 * PRSprint 16 (docs/prsprints/PRSPRINT_16_NOTIFICATION_PREFERENCES_DELIVERY_HISTORY.md), requirement
 * #5/#6: what the app actually knows about a user's ability to receive SMS, distinct from whether
 * they've *chosen* to (that's the ordinary preference row). `phoneVerified` mirrors exactly what
 * `UserContactReader.getPhone` itself requires (a verified SMS MFA credential) — this is intentionally
 * the same signal, exposed for the UI to explain *why* a toggle can't be meaningfully enabled, not a
 * second, different notion of "verified."
 */
export interface SmsEligibility {
  phoneVerified: boolean;
  /** Masked (e.g. "+1********67") — never the full number, even to the owning user's own preferences view; the account/security page is where the real number is managed. */
  maskedPhone: string | null;
  /** True if the verified phone (or, if unverified, no phone at all — always false in that case since there is nothing to have opted out) is present in sms_opt_out. */
  optedOut: boolean;
}

/**
 * PRSprint 16, requirement #18/#21: one logical notification (one `notify()` call), not one row per
 * channel — every channel that call fanned out to is reunified here via the caller-supplied dedupe
 * key (with `:channel` stripped), which every `notify()` call site in this codebase already supplies
 * (audited directly, not assumed) — see `listGroupedForUser`'s own doc comment for the fallback when
 * one doesn't exist.
 */
export interface GroupedChannelStatus {
  channel: NotificationChannel;
  /** A real notification_event status when a row exists for this channel; "not_sent" (with `reason`) when this channel was eligible for the type but no row exists — e.g. excluded by the recipient's own preference. */
  status: NotificationStatus | "not_sent";
  failureReason: string | null;
  reason?: string;
}

export interface GroupedNotification {
  groupId: string;
  notificationType: string;
  critical: boolean;
  relatedAgreementId: string | null;
  relatedPaymentAttemptId: string | null;
  relatedInvitationId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
  /** From the group's own in_app row, if one exists (a user may have disabled in_app for this type, same as any other channel). */
  readAt: Date | null;
  /** The in_app row's own id — what a "mark read" action targets. Null when no in_app row exists for this group. */
  inAppId: string | null;
  channels: GroupedChannelStatus[];
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
      /** PRSprint 15: STOP-driven suppression — checked before every SMS send attempt. */
      smsOptOuts: SmsOptOutRepository;
      /** PRSprint 14: base URL used to build the CTA link on an email notification, when the event has a `relatedAgreementId` to link to (see `buildCtaUrl`). Mirrors AgreementInvitationService/AuthService's own identical `appUrl` dependency. */
      appUrl: string;
      /** PRSprint 16, requirement #17: records a preference change to the audit trail. Optional — mirrors PaymentWebhookService's own "notifications remain optional" precedent; a missing/failing audit write must never block the preference update it's recording. */
      audit?: AuditService;
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
    relatedInvitationId?: string | null;
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
        relatedInvitationId: input.relatedInvitationId ?? null,
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
    // PRSprint 16, requirement #16: read the prior value first so the audit record captures a real
    // old→new transition, not just "someone touched this" — also makes the upsert itself trivially
    // idempotent to observe (setting the same value twice produces two audit rows with identical
    // old/new, not a misleading "changed" entry).
    const previous = await this.deps.preferences.find(input.userId, input.notificationType, input.channel);
    await this.deps.preferences.upsert({
      userId: input.userId,
      notificationType: input.notificationType,
      channel: input.channel,
      enabled: input.enabled,
    });
    if (this.deps.audit) {
      try {
        await this.deps.audit.record({
          actorUserId: input.userId,
          actorRole: "personal_user",
          profileKind: null,
          profileId: null,
          agreementId: null,
          action: "notification_preference_changed",
          occurredAt: new Date().toISOString(),
          ipAddress: null,
          deviceInfo: null,
          previousValue: { notificationType: input.notificationType, channel: input.channel, enabled: previous?.enabled ?? true },
          newValue: { notificationType: input.notificationType, channel: input.channel, enabled: input.enabled },
          reason: null,
          authStrength: null,
          relatedDocumentId: null,
          relatedCaseId: null,
        });
      } catch (error) {
        // Failure isolation, matching every other optional cross-cutting dependency in this codebase
        // (PaymentWebhookService.notifyPaymentStatus's identical precedent) — an audit-write failure
        // must never roll back or block the preference change it's recording.
        logger.error("notification_preference_audit_failed", { userId: input.userId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  async listForUser(recipientUserId: string): Promise<NotificationEventRecord[]> {
    return this.deps.events.listForUser(recipientUserId);
  }

  /**
   * PRSprint 16, requirement #18/#21: the user-facing history view — one entry per `notify()` call,
   * not one per channel row. Every row's stored `dedupeKey` is `${callerSuppliedKey}:${channel}`
   * (notify()'s own construction); stripping the trailing `:${channel}` recovers the caller-supplied
   * key shared by every channel sibling of the same logical call. Audited directly: every notify()
   * call site in this codebase supplies a dedupeKey (no exceptions found), so the `row.id` fallback
   * below is a defensive last resort, not an expected path.
   *
   * For a channel the type is normally eligible for (`DEFAULT_CHANNELS[type]`) but that has no row in
   * this group, distinguishes *why*: an explicit stored preference disabling it ("not_sent" +
   * `disabled by your notification preference`) versus anything else — most commonly a type gaining a
   * channel after this particular notification was already created (`DEFAULT_CHANNELS` has changed
   * over time — PRSprint 15 added `sms` to five types) — labeled generically rather than claiming a
   * specific cause it can't actually verify for historical data.
   */
  async listGroupedForUser(recipientUserId: string): Promise<GroupedNotification[]> {
    const rows = await this.deps.events.listForUser(recipientUserId);
    const groups = new Map<string, GroupedNotification>();
    for (const row of rows) {
      const groupKey = row.dedupeKey && row.dedupeKey.endsWith(`:${row.channel}`) ? row.dedupeKey.slice(0, -(row.channel.length + 1)) : row.id;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          groupId: groupKey,
          notificationType: row.notificationType,
          critical: row.critical,
          relatedAgreementId: row.relatedAgreementId,
          relatedPaymentAttemptId: row.relatedPaymentAttemptId,
          relatedInvitationId: row.relatedInvitationId,
          payload: row.payload,
          createdAt: row.createdAt,
          readAt: null,
          inAppId: null,
          channels: [],
        };
        groups.set(groupKey, group);
      }
      group.channels.push({ channel: row.channel, status: row.status, failureReason: row.failureReason });
      if (row.channel === "in_app") {
        group.readAt = row.readAt;
        group.inAppId = row.id;
      }
      if (row.createdAt < group.createdAt) group.createdAt = row.createdAt;
    }

    for (const group of groups.values()) {
      const type = group.notificationType as NotificationEventType;
      const eligibleChannels = DEFAULT_CHANNELS[type] ?? [];
      const present = new Set(group.channels.map((c) => c.channel));
      for (const channel of eligibleChannels) {
        if (present.has(channel)) continue;
        const preference = group.critical ? null : await this.deps.preferences.find(recipientUserId, type, channel);
        group.channels.push({
          channel,
          status: "not_sent",
          failureReason: null,
          reason: preference && !preference.enabled ? "disabled by your notification preference" : "not applicable to this notification",
        });
      }
    }

    return [...groups.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** PRSprint 16, requirement #5/#6: what the UI needs to explain SMS eligibility honestly, without exposing infrastructure terms — see `SmsEligibility`'s own doc comment. */
  async getSmsEligibility(userId: string): Promise<SmsEligibility> {
    const phone = await this.deps.contacts.getPhone(userId);
    if (!phone) {
      return { phoneVerified: false, maskedPhone: null, optedOut: false };
    }
    const optedOut = await this.deps.smsOptOuts.isOptedOut(phone);
    return { phoneVerified: true, maskedPhone: maskPhone(phone), optedOut };
  }

  async markRead(recipientUserId: string, notificationId: string): Promise<NotificationEventRecord | null> {
    return this.deps.events.markRead(notificationId, recipientUserId, new Date());
  }

  /**
   * PRSprint 14, requirement #34 (admin retry): re-attempts exactly one failed email delivery, on the
   * caller's behalf — the caller (EmailDeliveryAdminService) is responsible for the capability check;
   * this method only enforces that the record is actually in a retryable state, so calling it twice in
   * a row (or on a row that has already since succeeded) is rejected rather than silently re-sending —
   * "must remain idempotent," verbatim. Never creates a new notification_event row or a new business
   * event — it operates on the existing one, re-rendering its template from the already-stored payload
   * exactly like `retryDueNotifications` does for the cron path.
   */
  async redeliverFailedEvent(id: string): Promise<NotificationEventRecord> {
    const record = await this.deps.events.findById(id);
    if (!record) throw new ValidationError("Notification event not found.");
    if (record.status !== "failed") {
      throw new ValidationError("Only a failed notification event can be retried.");
    }
    const type = record.notificationType as NotificationEventType;
    const template = NOTIFICATION_TEMPLATES[type];
    const rendered = template ? template(record.payload) : { subject: "Notification", emailBody: "", smsBody: "", inAppBody: "" };
    return this.deliver(record, rendered);
  }

  /**
   * PRSprint 14/15, requirement #27 (email)/#22 (SMS): the only way a provider's delivery-status
   * webhook is allowed to change a notification_event row's status — the webhook route
   * (src/app/api/webhooks/email/resend/route.ts, src/app/api/webhooks/sms/twilio/status/route.ts)
   * verifies the provider's signature first, then looks the row up by `providerMessageId` (never
   * trusts a client/provider-supplied notification_event id directly) and calls this, mapping its own
   * provider-specific event name into the generic `outcome`/`failureReason` shape below. `delivered`
   * is the only outcome that can still be retried later by definition (delivery already happened);
   * `failed` stops retrying immediately — hammering a permanently-undeliverable/bounced/complained-
   * about/opted-out destination is exactly what requirement #28/#29 (email) and #24/#25 (SMS)
   * prohibit — without touching any other notification_event row for the same recipient, and without
   * mutating anything on the business side (agreement/account state is never touched here).
   */
  async recordProviderDeliveryEvent(providerMessageId: string, outcome: "delivered" | "failed", failureReason: string, occurredAt: Date): Promise<NotificationEventRecord | null> {
    const record = await this.deps.events.findByProviderMessageId(providerMessageId);
    if (!record) return null;
    if (outcome === "delivered") {
      return this.deps.events.markDelivered(record.id, occurredAt);
    }
    return this.deps.events.markFailed(record.id, {
      failureReason,
      attemptCount: record.attemptCount,
      nextRetryAt: null,
    });
  }

  /** PRSprint 14/15, requirement #27/#33: minimal admin operational visibility — read-only, no payload beyond what the row already stores. Authorization lives in the caller (EmailDeliveryAdminService/SmsDeliveryAdminService), not here. */
  async listRecentByChannel(channel: NotificationChannel, limit: number): Promise<NotificationEventRecord[]> {
    return this.deps.events.listRecentByChannel(channel, limit);
  }

  /** PRSprint 15, requirement #24: called by the Twilio inbound-message webhook once a STOP-family keyword is verified — never by anything else, never on a client's direct say-so. */
  async recordSmsOptOut(phone: string): Promise<void> {
    await this.deps.smsOptOuts.recordOptOut(phone, "stop_keyword");
  }

  private buildCtaUrl(record: NotificationEventRecord): { ctaUrl: string; ctaText: string } | null {
    if (record.relatedInvitationId) {
      return { ctaUrl: `${this.deps.appUrl}/connections/accept?invitationId=${record.relatedInvitationId}`, ctaText: "Review invitation" };
    }
    if (record.relatedAgreementId) {
      return { ctaUrl: `${this.deps.appUrl}/agreements/detail?id=${record.relatedAgreementId}`, ctaText: "Review agreement" };
    }
    return null;
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
        const cta = this.buildCtaUrl(record);
        const result = await this.deps.emailSender.send({
          to: email,
          subject: rendered.subject,
          body: rendered.emailBody,
          ctaUrl: cta?.ctaUrl,
          ctaText: cta?.ctaText,
        });
        // "sent" (provider accepted), not "delivered" — see enums.ts's notificationStatusEnum doc
        // comment. Real delivery confirmation, if it comes, arrives later via the provider's webhook
        // (recordProviderDeliveryEvent), never synchronously here.
        return this.deps.events.markSent(record.id, { sentAt: new Date(), providerMessageId: result.providerMessageId });
      }
      // sms
      const phone = await this.deps.contacts.getPhone(record.recipientUserId);
      if (!phone) return record; // no verified SMS-capable phone on file — recorded, left pending, not a failure.
      if (await this.deps.smsOptOuts.isOptedOut(phone)) {
        // Never even attempt the send — requirement #24: "do not continue ordinary SMS delivery in
        // violation of provider/carrier rules." Terminal, not retryable: opting back in (a fresh
        // START reply) doesn't retroactively resurrect this specific already-suppressed attempt.
        return this.deps.events.markFailed(record.id, { failureReason: "recipient_opted_out", attemptCount: record.attemptCount, nextRetryAt: null });
      }
      const cta = this.buildCtaUrl(record);
      const smsBody = cta ? `${rendered.smsBody} ${cta.ctaUrl}` : rendered.smsBody;
      const result = await this.deps.smsSender.send({ to: phone, body: smsBody });
      // "sent" (provider accepted), not "delivered" — mirrors email's identical PRSprint 14
      // correction. Real handset-delivery confirmation, if the provider offers one, arrives later via
      // its own status-callback webhook (recordProviderDeliveryEvent), never synchronously here.
      return this.deps.events.markSent(record.id, { sentAt: new Date(), providerMessageId: result.providerMessageId });
    } catch (error) {
      // A non-retryable provider failure (invalid recipient, malformed request, provider
      // misconfiguration, opted-out destination) is dead-lettered immediately rather than exhausting
      // the usual bounded-retry budget first — retrying an identical request against the same
      // permanent rejection would only delay the terminal state, not change it (requirement #22/#25).
      const nonRetryable = (error instanceof EmailDeliveryError || error instanceof SmsDeliveryError) && !error.retryable;
      const attemptCount = record.attemptCount + 1;
      const exhausted = nonRetryable || attemptCount >= this.maxAttempts;
      return this.deps.events.markFailed(record.id, {
        failureReason: error instanceof Error ? error.message : "unknown_delivery_error",
        attemptCount,
        nextRetryAt: exhausted ? null : new Date(Date.now() + this.retryDelayMs),
      });
    }
  }
}
