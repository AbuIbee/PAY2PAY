import "server-only";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { DrizzleInstallmentStatusRepository } from "./drizzleInstallmentStatusRepository";
import { FailedPaymentWorkflowService } from "./failedPaymentWorkflowService";
import { getFailedPaymentRetryCoordinator } from "./getFailedPaymentRetryCoordinator";
import { getPaymentRetryService } from "./getPaymentRetryService";

let cached: FailedPaymentWorkflowService | null = null;

export function getFailedPaymentWorkflowService(): FailedPaymentWorkflowService {
  if (!cached) {
    cached = new FailedPaymentWorkflowService({
      installments: new DrizzleInstallmentStatusRepository(),
      retries: getPaymentRetryService(),
      notifications: getNotificationService(),
      profileOwners: new DrizzleProfileOwnerReader(),
      // PACKAGE B — remaining Codex blockers: real production wiring always supplies the atomic
      // coordinator — see FailedPaymentRetryCoordinator's own doc comment.
      retryCoordinator: getFailedPaymentRetryCoordinator(),
    });
  }
  return cached;
}
