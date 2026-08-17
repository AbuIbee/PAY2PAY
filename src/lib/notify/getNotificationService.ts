import "server-only";
import { getServerEnv } from "@/config/env";
import { DrizzleNotificationEventRepository } from "./drizzleNotificationEventRepository";
import { DrizzleNotificationPreferenceRepository } from "./drizzleNotificationPreferenceRepository";
import { DrizzleSmsOptOutRepository } from "./drizzleSmsOptOutRepository";
import { DrizzleUserContactReader } from "./drizzleUserContactReader";
import { getEmailSender } from "./getEmailSender";
import { getSmsSender } from "./getSmsSender";
import { NotificationService } from "./notificationService";

let cached: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  if (!cached) {
    const { APP_URL } = getServerEnv();
    cached = new NotificationService({
      events: new DrizzleNotificationEventRepository(),
      preferences: new DrizzleNotificationPreferenceRepository(),
      emailSender: getEmailSender(),
      smsSender: getSmsSender(),
      contacts: new DrizzleUserContactReader(),
      smsOptOuts: new DrizzleSmsOptOutRepository(),
      appUrl: APP_URL,
    });
  }
  return cached;
}
