import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { NotificationService } from "@/lib/notify/notificationService";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { AgreementRecord, AgreementService, AgreementStatus, PartyRole } from "./agreementService";

export type AgreementCancellationRequestStatus = "pending" | "accepted" | "rejected";

export interface AgreementCancellationRequestRecord {
  id: string;
  agreementId: string;
  status: AgreementCancellationRequestStatus;
  requestedByPartyRole: PartyRole;
  requestedByProfileKind: ProfileKind;
  requestedByProfileId: string;
  reason: string;
  decidedByProfileKind: ProfileKind | null;
  decidedByProfileId: string | null;
  rejectedReason: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Real implementation: DrizzleAgreementCancellationRepository. */
export interface AgreementCancellationRequestRepository {
  insert(input: {
    agreementId: string;
    requestedByPartyRole: PartyRole;
    requestedByProfileKind: ProfileKind;
    requestedByProfileId: string;
    reason: string;
  }): Promise<AgreementCancellationRequestRecord>;
  findById(id: string): Promise<AgreementCancellationRequestRecord | null>;
  listForAgreement(agreementId: string): Promise<AgreementCancellationRequestRecord[]>;
  recordAccepted(id: string, decidedBy: { profileKind: ProfileKind; profileId: string }): Promise<AgreementCancellationRequestRecord>;
  recordRejected(
    id: string,
    decidedBy: { profileKind: ProfileKind; profileId: string },
    rejectedReason: string | null,
  ): Promise<AgreementCancellationRequestRecord>;
}

export interface AgreementCancellationServiceDeps {
  agreementService: AgreementService;
  requests: AgreementCancellationRequestRepository;
  profileOwners: ProfileOwnerReader;
  notifications?: NotificationService;
  audit: AuditService;
}

/**
 * Mutual cancellation (mandatory command): "Request Cancellation" on an already-active agreement,
 * requiring the counterparty's real accept/decline — see agreementCancellation.ts's own doc comment
 * for why this is a distinct concept from the pre-signature `AgreementService.cancelAgreement`.
 * Deliberately never writes to `agreement.status` on request (the agreement stays genuinely active —
 * "pending cancellation" is a query-time fact derived from a pending row existing, never a stored
 * status) — only `decideCancellation`'s accept path does, at the one moment consent is actually
 * mutual.
 */
export class AgreementCancellationService {
  constructor(private readonly deps: AgreementCancellationServiceDeps) {}

  private static readonly CANCELLABLE_STATUSES: AgreementStatus[] = ["first_payment_pending", "active", "past_due"];

  async requestCancellation(input: { agreementId: string; actingUserId: string; reason: string }): Promise<AgreementCancellationRequestRecord> {
    if (!input.reason.trim()) {
      throw new ValidationError("A reason is required to request cancellation.");
    }
    const { agreement } = await this.deps.agreementService.getAgreement(input.agreementId, input.actingUserId);
    if (!AgreementCancellationService.CANCELLABLE_STATUSES.includes(agreement.status)) {
      throw new ValidationError(
        `Mutual cancellation can only be requested on an active agreement — this one is "${agreement.status}".`,
      );
    }
    const role = await this.deps.agreementService.resolvePartyRole(input.agreementId, input.actingUserId);
    const existing = await this.deps.requests.listForAgreement(input.agreementId);
    if (existing.some((r) => r.status === "pending")) {
      throw new ValidationError("A cancellation request is already pending for this agreement.");
    }
    const requester = role === "creditor" ? { kind: agreement.creditorProfileKind, id: agreement.creditorProfileId } : { kind: agreement.debtorProfileKind, id: agreement.debtorProfileId };

    const request = await this.deps.requests.insert({
      agreementId: input.agreementId,
      requestedByPartyRole: role,
      requestedByProfileKind: requester.kind,
      requestedByProfileId: requester.id,
      reason: input.reason,
    });
    await this.recordAudit(request, input.actingUserId, "agreement_cancellation_requested", { reason: input.reason });
    await this.notifyCounterparty(agreement, role, "agreement_cancellation_requested", { reason: input.reason }, request.id);
    return request;
  }

  async decideCancellation(input: {
    cancellationRequestId: string;
    actingUserId: string;
    decision: "accept" | "reject";
    rejectedReason?: string;
  }): Promise<AgreementCancellationRequestRecord> {
    const request = await this.requireRequest(input.cancellationRequestId);
    if (request.status !== "pending") {
      throw new ValidationError(`This request has already been decided ("${request.status}").`);
    }
    const role = await this.deps.agreementService.resolvePartyRole(request.agreementId, input.actingUserId);
    if (role === request.requestedByPartyRole) {
      throw new ForbiddenError("You requested this cancellation — only the other party may accept or decline it.");
    }
    const { agreement } = await this.deps.agreementService.getAgreement(request.agreementId, input.actingUserId);
    const decider =
      role === "creditor"
        ? { profileKind: agreement.creditorProfileKind, profileId: agreement.creditorProfileId }
        : { profileKind: agreement.debtorProfileKind, profileId: agreement.debtorProfileId };

    if (input.decision === "accept") {
      const updated = await this.deps.requests.recordAccepted(request.id, decider);
      await this.deps.agreementService.markMutuallyCanceled(request.agreementId, input.actingUserId, {
        cancellationRequestId: request.id,
      });
      await this.recordAudit(updated, input.actingUserId, "agreement_cancellation_accepted", null);
      await this.notifyRequester(agreement, request.requestedByPartyRole, "agreement_cancellation_decided", { decision: "accepted" }, request.id);
      return updated;
    }

    const updated = await this.deps.requests.recordRejected(request.id, decider, input.rejectedReason ?? null);
    await this.recordAudit(updated, input.actingUserId, "agreement_cancellation_rejected", { rejectedReason: input.rejectedReason ?? null });
    await this.notifyRequester(agreement, request.requestedByPartyRole, "agreement_cancellation_decided", { decision: "rejected" }, request.id);
    return updated;
  }

  async getCancellationRequest(cancellationRequestId: string, actingUserId: string): Promise<AgreementCancellationRequestRecord> {
    const request = await this.requireRequest(cancellationRequestId);
    await this.deps.agreementService.resolvePartyRole(request.agreementId, actingUserId);
    return request;
  }

  async listCancellationRequests(agreementId: string, actingUserId: string): Promise<AgreementCancellationRequestRecord[]> {
    await this.deps.agreementService.resolvePartyRole(agreementId, actingUserId);
    return this.deps.requests.listForAgreement(agreementId);
  }

  private async requireRequest(id: string): Promise<AgreementCancellationRequestRecord> {
    const request = await this.deps.requests.findById(id);
    if (!request) throw new ValidationError("Cancellation request not found.");
    return request;
  }

  private async recordAudit(
    request: AgreementCancellationRequestRecord,
    actorUserId: string,
    action: string,
    newValue: unknown,
  ): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "agreement_party",
      profileKind: request.requestedByProfileKind,
      profileId: request.requestedByProfileId,
      agreementId: request.agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue,
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "agreement_cancellation_request",
      targetResourceId: request.id,
    });
  }

  /** Mirrors AmendmentService.notifyParty's identical optional-dependency/try-catch precedent. */
  private async notifyCounterparty(
    agreement: AgreementRecord,
    requesterRole: PartyRole,
    notificationType: "agreement_cancellation_requested",
    payload: Record<string, unknown>,
    requestId: string,
  ): Promise<void> {
    const counterpartyRole: PartyRole = requesterRole === "creditor" ? "debtor" : "creditor";
    await this.notifyRole(agreement, counterpartyRole, notificationType, payload, requestId);
  }

  private async notifyRequester(
    agreement: AgreementRecord,
    requesterRole: PartyRole,
    notificationType: "agreement_cancellation_decided",
    payload: Record<string, unknown>,
    requestId: string,
  ): Promise<void> {
    await this.notifyRole(agreement, requesterRole, notificationType, payload, requestId);
  }

  private async notifyRole(
    agreement: AgreementRecord,
    role: PartyRole,
    notificationType: "agreement_cancellation_requested" | "agreement_cancellation_decided",
    payload: Record<string, unknown>,
    requestId: string,
  ): Promise<void> {
    if (!this.deps.notifications) return;
    try {
      const profile = role === "creditor" ? { kind: agreement.creditorProfileKind, id: agreement.creditorProfileId } : { kind: agreement.debtorProfileKind, id: agreement.debtorProfileId };
      const recipientUserId = await this.deps.profileOwners.getOwnerUserId(profile.kind, profile.id);
      if (!recipientUserId) return;
      await this.deps.notifications.notify({
        recipientUserId,
        notificationType,
        relatedAgreementId: agreement.id,
        payload,
        dedupeKey: `${notificationType}:${agreement.id}:cancel:${requestId}:${recipientUserId}`,
      });
    } catch (error) {
      logger.error("agreement_cancellation_notification_failed", {
        agreementId: agreement.id,
        notificationType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
