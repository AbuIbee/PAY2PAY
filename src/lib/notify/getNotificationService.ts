import "server-only";
import { ConsoleEmailSender } from "./consoleEmailSender";
import { ConsoleSmsSender } from "./consoleSmsSender";
import { DrizzleNotificationEventRepository } from "./drizzleNotificationEventRepository";
import { DrizzleNotificationPreferenceRepository } from "./drizzleNotificationPreferenceRepository";
import { DrizzleUserContactReader } from "./drizzleUserContactReader";
import { NotificationService } from "./notificationService";

let cached: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  if (!cached) {
    cached = new NotificationService({
      events: new DrizzleNotificationEventRepository(),
      preferences: new DrizzleNotificationPreferenceRepository(),
      emailSender: new ConsoleEmailSender(),
      smsSender: new ConsoleSmsSender(),
      contacts: new DrizzleUserContactReader(),
    });
  }
  return cached;
}
