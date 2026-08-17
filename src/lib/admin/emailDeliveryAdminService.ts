import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import type { PlatformRole } from "@/lib/auth/authService";
import type { NotificationEventRecord, NotificationService } from "@/lib/notify/notificationService";
import type { AdminRoleService } from "./adminRoleService";

const DEFAULT_LIST_LIMIT = 100;

export interface EmailDeliveryAdminServiceDeps {
  notifications: NotificationService;
  roles: AdminRoleService;
  audit: AuditService;
}

/**
 * PRSprint 14 (docs/prsprints/PRSPRINT_14_PRODUCTION_EMAIL.md), requirement #33/#34: the thin
 * admin-facing wrapper around `NotificationService`'s own email-delivery methods — this class owns
 * nothing on its own (no repository, no state); it exists to hold the capability gate and audit
 * logging in one place, mirroring `RetentionHoldService`'s identical shape exactly (wraps a narrower
 * service/repository + `AdminRoleService` + `AuditService`).
 *
 * Deliberately does not expose `payload` (may include user-chosen display names or agreement stage
 * labels — non-sensitive, but also not needed for operational triage) or the recipient's actual email
 * address (never persisted on the row in the first place — resolved live, at send time, from
 * `recipientUserId`; see NotificationEventRecord's own doc comment) — only `recipientUserId`, which is
 * already an internal identifier admins routinely see elsewhere (user detail pages, audit logs).
 */
export class EmailDeliveryAdminService {
  constructor(private readonly deps: EmailDeliveryAdminServiceDeps) {}

  async listRecent(actingUserId: string, actingRole: PlatformRole, limit: number = DEFAULT_LIST_LIMIT): Promise<NotificationEventRecord[]> {
    await this.deps.roles.requireCapability(actingUserId, actingRole, "review_email_delivery");
    return this.deps.notifications.listRecentEmailEvents(limit);
  }

  async retry(input: { notificationEventId: string; actingUserId: string; actingRole: PlatformRole }): Promise<NotificationEventRecord> {
    await this.deps.roles.requireCapability(input.actingUserId, input.actingRole, "retry_email_delivery");
    const updated = await this.deps.notifications.redeliverFailedEvent(input.notificationEventId);
    await this.deps.audit.record({
      actorUserId: input.actingUserId,
      actorRole: "platform_admin",
      profileKind: null,
      profileId: null,
      agreementId: updated.relatedAgreementId,
      action: "admin_email_delivery_retried",
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
