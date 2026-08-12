import "server-only";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { DrizzleInstallmentStatusRepository } from "./drizzleInstallmentStatusRepository";
import { FailedPaymentWorkflowService } from "./failedPaymentWorkflowService";
import { getPaymentRetryService } from "./getPaymentRetryService";

let cached: FailedPaymentWorkflowService | null = null;

export function getFailedPaymentWorkflowService(): FailedPaymentWorkflowService {
  if (!cached) {
    cached = new FailedPaymentWorkflowService({
      installments: new DrizzleInstallmentStatusRepository(),
      retries: getPaymentRetryService(),
      notifications: getNotificationService(),
      profileOwners: new DrizzleProfileOwnerReader(),
    });
  }
  return cached;
}
