import "server-only";
import type { EmailSender } from "./emailSender";

export interface NotificationEventRecord {
  id: string;
  recipientUserId: string;
  notificationType: string;
  relatedPaymentAttemptId: string | null;
  relatedAgreementId: string | null;
  payload: Record<string, unknown>;
  deliveredAt: Date | null;
  createdAt: Date;
}

/** Real implementation: DrizzleNotificationEventRepository. */
export interface NotificationEventRepository {
  insert(input: {
    recipientUserId: string;
    notificationType: string;
    relatedPaymentAttemptId: string | null;
    relatedAgreementId: string | null;
    payload: Record<string, unknown>;
  }): Promise<NotificationEventRecord>;
  markDelivered(id: string, deliveredAt: Date): Promise<void>;
  listForUser(recipientUserId: string): Promise<NotificationEventRecord[]>;
}

/** Real implementation: DrizzleUserContactReader (queries user_account.email directly). */
export interface UserContactReader {
  getEmail(userId: string): Promise<string | null>;
}

/**
 * Sprint 13 (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md): the minimal internal
 * notification primitive `docs/SPRINT_CONTROL.md`'s "Sequencing risk 1" resolution calls for —
 * every call durably records a `notification_event` row first (this is the part Sprint 17
 * (`docs/sprints/SPRINT_17_Notifications.md`) will read from and build real multi-channel delivery
 * on top of), then attempts best-effort delivery through whatever `EmailSender` is wired in — Sprint
 * 2's `ConsoleEmailSender` today, matching that sprint's own "no other code needs to change" design
 * intent when a real provider is swapped in later. A missing/undeliverable email address is not an
 * error: the event record itself is the durable artifact this method's caller can rely on existing,
 * independent of whether delivery succeeded.
 */
export class NotificationService {
  constructor(
    private readonly deps: {
      events: NotificationEventRepository;
      emailSender: EmailSender;
      contacts: UserContactReader;
    },
  ) {}

  async notify(input: {
    recipientUserId: string;
    notificationType: string;
    relatedPaymentAttemptId?: string | null;
    relatedAgreementId?: string | null;
    subject: string;
    body: string;
    payload: Record<string, unknown>;
  }): Promise<NotificationEventRecord> {
    const record = await this.deps.events.insert({
      recipientUserId: input.recipientUserId,
      notificationType: input.notificationType,
      relatedPaymentAttemptId: input.relatedPaymentAttemptId ?? null,
      relatedAgreementId: input.relatedAgreementId ?? null,
      payload: input.payload,
    });

    const email = await this.deps.contacts.getEmail(input.recipientUserId);
    if (email) {
      await this.deps.emailSender.send({ to: email, subject: input.subject, body: input.body });
      await this.deps.events.markDelivered(record.id, new Date());
    }
    return record;
  }
}
