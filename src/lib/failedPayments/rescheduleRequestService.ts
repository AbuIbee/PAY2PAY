import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { InstallmentStatusRepository } from "./installmentStatusRepository";

export type RescheduleRequestStatus = "pending" | "approved" | "rejected";

export interface RescheduleRequestRecord {
  id: string;
  installmentScheduleItemId: string;
  agreementId: string;
  requestedByProfileKind: ProfileKind;
  requestedByProfileId: string;
  currentDueDate: string;
  requestedDueDate: string;
  reason: string | null;
  status: RescheduleRequestStatus;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  createdAt: Date;
}

/** Real implementation: DrizzleRescheduleRequestRepository. */
export interface RescheduleRequestRepository {
  insert(input: {
    installmentScheduleItemId: string;
    agreementId: string;
    requestedByProfileKind: ProfileKind;
    requestedByProfileId: string;
    currentDueDate: string;
    requestedDueDate: string;
    reason: string | null;
  }): Promise<RescheduleRequestRecord>;
  findById(id: string): Promise<RescheduleRequestRecord | null>;
  decide(
    id: string,
    status: "approved" | "rejected",
    decidedByUserId: string,
    decidedAt: Date,
    decisionReason: string | null,
  ): Promise<RescheduleRequestRecord>;
}

/**
 * Narrow read of an agreement's two parties — deliberately its own interface (mirrors
 * `AgreementTermsReader`/`AgreementFeeAllocationReader`) rather than a dependency on the full
 * `AgreementService`, which this class has no other need for.
 */
export interface AgreementPartiesReader {
  getParties(
    agreementId: string,
  ): Promise<{ creditor: { profileKind: ProfileKind; profileId: string }; debtor: { profileKind: ProfileKind; profileId: string } } | null>;
}

/**
 * Sprint 13 (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md) requirements #9–#10: "Borrower
 * may request new payment date. Creditor approval required to formally reschedule." The installment's
 * `due_date` is written only inside `decideReschedule`'s approved branch — never in
 * `requestReschedule` — which is the concrete mechanism behind "creditor approval required," not
 * just a status label on an otherwise-already-applied change.
 *
 * Known limitation: creditor-side authorization here checks only the agreement's creditor profile's
 * *owning user* (`ProfileOwnerReader`), not Sprint 4's fuller business-staff delegated-capability
 * model (`business_staff_member` / `StaffService`) that `AgreementService.creditorDecide` integrates
 * with for other agreement decisions. A staff member with delegated approval authority cannot decide
 * a reschedule request in this sprint — only the creditor profile's owner can. Documented here rather
 * than silently assumed, consistent with this project's practice of flagging scope simplifications.
 */
export class RescheduleRequestService {
  constructor(
    private readonly deps: {
      requests: RescheduleRequestRepository;
      installments: InstallmentStatusRepository;
      parties: AgreementPartiesReader;
      profileOwners: ProfileOwnerReader;
      audit: AuditService;
    },
  ) {}

  async requestReschedule(input: {
    installmentScheduleItemId: string;
    agreementId: string;
    requestedDueDate: string;
    reason: string | null;
    actingUserId: string;
  }): Promise<RescheduleRequestRecord> {
    const parties = await this.deps.parties.getParties(input.agreementId);
    if (!parties) throw new ValidationError("Agreement not found.");

    const debtorOwner = await this.deps.profileOwners.getOwnerUserId(parties.debtor.profileKind, parties.debtor.profileId);
    if (debtorOwner !== input.actingUserId) {
      throw new ForbiddenError("Only the borrower may request a new payment date for this installment.");
    }

    const currentDueDate = await this.deps.installments.findDueDate(input.installmentScheduleItemId);
    if (!currentDueDate) throw new ValidationError("Installment not found.");
    if (input.requestedDueDate <= currentDueDate) {
      // Plain string comparison is valid here — both are always well-formed YYYY-MM-DD (zod-validated
      // at the route boundary), which sorts identically to date comparison.
      throw new ValidationError("The requested due date must be after the installment's current due date.");
    }

    const record = await this.deps.requests.insert({
      installmentScheduleItemId: input.installmentScheduleItemId,
      agreementId: input.agreementId,
      requestedByProfileKind: parties.debtor.profileKind,
      requestedByProfileId: parties.debtor.profileId,
      currentDueDate,
      requestedDueDate: input.requestedDueDate,
      reason: input.reason,
    });
    await this.recordAudit(record, "reschedule_requested", input.actingUserId, input.reason);
    return record;
  }

  async decideReschedule(input: {
    requestId: string;
    decision: "approved" | "rejected";
    decisionReason: string | null;
    actingUserId: string;
  }): Promise<RescheduleRequestRecord> {
    const request = await this.deps.requests.findById(input.requestId);
    if (!request) throw new ValidationError("Reschedule request not found.");
    if (request.status !== "pending") {
      throw new ValidationError("This reschedule request has already been decided.");
    }

    const parties = await this.deps.parties.getParties(request.agreementId);
    if (!parties) throw new ValidationError("Agreement not found.");
    const creditorOwner = await this.deps.profileOwners.getOwnerUserId(parties.creditor.profileKind, parties.creditor.profileId);
    if (creditorOwner !== input.actingUserId) {
      throw new ForbiddenError("Only the creditor may decide a reschedule request.");
    }

    const decided = await this.deps.requests.decide(request.id, input.decision, input.actingUserId, new Date(), input.decisionReason);

    if (input.decision === "approved") {
      // The only place this sprint ever writes installment_schedule_item.due_date.
      await this.deps.installments.updateDueDate(decided.installmentScheduleItemId, decided.requestedDueDate);
    }

    await this.recordAudit(
      decided,
      input.decision === "approved" ? "reschedule_approved" : "reschedule_rejected",
      input.actingUserId,
      input.decisionReason,
    );
    return decided;
  }

  private async recordAudit(
    request: RescheduleRequestRecord,
    action: string,
    actorUserId: string,
    reason: string | null,
  ): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "personal_user",
      profileKind: request.requestedByProfileKind,
      profileId: request.requestedByProfileId,
      agreementId: request.agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: request.currentDueDate,
      newValue: request.requestedDueDate,
      reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "reschedule_request",
      targetResourceId: request.id,
    });
  }
}
