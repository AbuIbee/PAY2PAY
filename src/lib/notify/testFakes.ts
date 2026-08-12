import { randomUUID } from "node:crypto";
import type { EmailSender } from "./emailSender";
import { NotificationService } from "./notificationService";
import type { NotificationEventRecord, NotificationEventRepository, UserContactReader } from "./notificationService";

/** Test-only in-memory doubles for NotificationService, mirroring src/lib/payments/testFakes.ts's pattern. */

export class InMemoryNotificationEventRepository implements NotificationEventRepository {
  byId = new Map<string, NotificationEventRecord>();

  async insert(input: {
    recipientUserId: string;
    notificationType: string;
    relatedPaymentAttemptId: string | null;
    relatedAgreementId: string | null;
    payload: Record<string, unknown>;
  }): Promise<NotificationEventRecord> {
    const record: NotificationEventRecord = { id: randomUUID(), deliveredAt: null, createdAt: new Date(), ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async markDelivered(id: string, deliveredAt: Date): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.deliveredAt = deliveredAt;
  }

  async listForUser(recipientUserId: string): Promise<NotificationEventRecord[]> {
    return [...this.byId.values()].filter((e) => e.recipientUserId === recipientUserId);
  }
}

export class InMemoryUserContactReader implements UserContactReader {
  private byUserId = new Map<string, string>();

  set(userId: string, email: string): void {
    this.byUserId.set(userId, email);
  }

  async getEmail(userId: string): Promise<string | null> {
    return this.byUserId.get(userId) ?? null;
  }
}

export class InMemoryEmailSender implements EmailSender {
  sent: { to: string; subject: string; body: string }[] = [];

  async send(input: { to: string; subject: string; body: string }): Promise<void> {
    this.sent.push(input);
  }
}

export function createTestNotificationService() {
  const events = new InMemoryNotificationEventRepository();
  const contacts = new InMemoryUserContactReader();
  const emailSender = new InMemoryEmailSender();
  const notificationService = new NotificationService({ events, emailSender, contacts });
  return { events, contacts, emailSender, notificationService };
}
