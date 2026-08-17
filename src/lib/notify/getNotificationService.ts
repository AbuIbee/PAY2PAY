import "server-only";
import { getServerEnv } from "@/config/env";
import { ConsoleSmsSender } from "./consoleSmsSender";
import { DrizzleNotificationEventRepository } from "./drizzleNotificationEventRepository";
import { DrizzleNotificationPreferenceRepository } from "./drizzleNotificationPreferenceRepository";
import { DrizzleUserContactReader } from "./drizzleUserContactReader";
import { getEmailSender } from "./getEmailSender";
import { NotificationService } from "./notificationService";

let cached: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  if (!cached) {
    const { APP_URL } = getServerEnv();
    cached = new NotificationService({
      events: new DrizzleNotificationEventRepository(),
      preferences: new DrizzleNotificationPreferenceRepository(),
      emailSender: getEmailSender(),
      smsSender: new ConsoleSmsSender(),
      contacts: new DrizzleUserContactReader(),
      appUrl: APP_URL,
    });
  }
  return cached;
}
