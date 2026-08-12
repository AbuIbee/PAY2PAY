import "server-only";
import { ConsoleEmailSender } from "./consoleEmailSender";
import { DrizzleNotificationEventRepository } from "./drizzleNotificationEventRepository";
import { DrizzleUserContactReader } from "./drizzleUserContactReader";
import { NotificationService } from "./notificationService";

let cached: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  if (!cached) {
    cached = new NotificationService({
      events: new DrizzleNotificationEventRepository(),
      emailSender: new ConsoleEmailSender(),
      contacts: new DrizzleUserContactReader(),
    });
  }
  return cached;
}
