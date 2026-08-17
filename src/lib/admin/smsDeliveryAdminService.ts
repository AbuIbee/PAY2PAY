import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import type { PlatformRole } from "@/lib/auth/authService";
import type { NotificationEventRecord, NotificationService } from "@/lib/notify/notificationService";
import type { AdminRoleService } from "./adminRoleService";

const DEFAULT_LIST_LIMIT = 100;

export interface SmsDeliveryAdminServiceDeps {
  notifications: NotificationService;
  roles: AdminRoleService;
  audit: AuditService;
}

/**
 * PRSprint 15 (docs/prsprints/PRSPRINT_15_PRODUCTION_SMS.md), requirement #27/#28: the SMS-channel
 * sibling of `EmailDeliveryAdminService` — same shape, same underlying `NotificationService` methods
 * (`listRecentByChannel`/`redeliverFailedEvent` are already channel-agnostic; see PRSprint 14's
 * "reuse the general notification delivery record with a channel field" design), a separate class
 * only so each channel keeps its own capability gate and audit trail (requirement #32: "each channel
 * needs independent delivery state... retries must be channel-specific").
 *
 * Deliberately does not expose the recipient's actual phone number (never persisted on the row in the
 * first place — resolved live, at send time, from `recipientUserId`) — only `recipientUserId`, same as
 * the email admin view.
 */
export class SmsDeliveryAdminService {
  constructor(private readonly deps: SmsDeliveryAdminServiceDeps) {}

  async listRecent(actingUserId: string, actingRole: PlatformRole, limit: number = DEFAULT_LIST_LIMIT): Promise<NotificationEventRecord[]> {
    await this.deps.roles.requireCapability(actingUserId, actingRole, "review_sms_delivery");
    return this.deps.notifications.listRecentByChannel("sms", limit);
  }

  async retry(input: { notificationEventId: string; actingUserId: string; actingRole: PlatformRole }): Promise<NotificationEventRecord> {
    await this.deps.roles.requireCapability(input.actingUserId, input.actingRole, "retry_sms_delivery");
    const updated = await this.deps.notifications.redeliverFailedEvent(input.notificationEventId);
    await this.deps.audit.record({
      actorUserId: input.actingUserId,
      actorRole: "platform_admin",
      profileKind: null,
      profileId: null,
      agreementId: updated.relatedAgreementId,
      action: "admin_sms_delivery_retried",
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: { notificationEventId: updated.id, status: updated.status },
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
    });
    return updated;
  }
}
