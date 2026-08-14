import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { InMemoryProfileOwnerReader } from "@/lib/profiles/testFakes";
import {
  InMemoryAgreementPartiesReader,
  InMemoryInstallmentStatusRepository,
  InMemoryRescheduleRequestRepository,
} from "./testFakes";
import { RescheduleRequestService } from "./rescheduleRequestService";

const DEBTOR = { profileKind: "personal" as const, profileId: "debtor-1" };
const CREDITOR = { profileKind: "business" as const, profileId: "creditor-1" };
const DEBTOR_USER_ID = "debtor-user-1";
const CREDITOR_USER_ID = "creditor-user-1";
const OTHER_USER_ID = "other-user-1";

class InMemoryAuditEventRepositoryForTest implements AuditEventRepository {
  events: AuditEventRecord[] = [];
  private nextId = 1;
  async getLastEvent(): Promise<AuditEventRecord | null> {
    return this.events.at(-1) ?? null;
  }
  async insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord> {
    const stored: AuditEventRecord = { ...record, id: this.nextId++ };
    this.events.push(stored);
    return stored;
  }
}

describe("RescheduleRequestService", () => {
  let requests: InMemoryRescheduleRequestRepository;
  let installments: InMemoryInstallmentStatusRepository;
  let parties: InMemoryAgreementPartiesReader;
  let profileOwners: InMemoryProfileOwnerReader;
  let auditRepo: InMemoryAuditEventRepositoryForTest;
  let service: RescheduleRequestService;
  const agreementId = randomUUID();
  const installmentId = randomUUID();

  beforeEach(() => {
    requests = new InMemoryRescheduleRequestRepository();
    installments = new InMemoryInstallmentStatusRepository();
    parties = new InMemoryAgreementPartiesReader();
    profileOwners = new InMemoryProfileOwnerReader();
    auditRepo = new InMemoryAuditEventRepositoryForTest();
    service = new RescheduleRequestService({
      requests,
      installments,
      parties,
      profileOwners,
      audit: new AuditService(auditRepo),
    });

    profileOwners.set(DEBTOR.profileKind, DEBTOR.profileId, DEBTOR_USER_ID);
    profileOwners.set(CREDITOR.profileKind, CREDITOR.profileId, CREDITOR_USER_ID);
    parties.set(agreementId, { creditor: CREDITOR, debtor: DEBTOR });
    installments.seed(installmentId, "2026-09-01", "past_due");
  });

  it("reschedule request: the borrower can request a new due date, capturing the current date as a snapshot", async () => {
    const request = await service.requestReschedule({
      installmentScheduleItemId: installmentId,
      agreementId,
      requestedDueDate: "2026-09-15",
      reason: "paycheck delayed",
      actingUserId: DEBTOR_USER_ID,
    });
    expect(request.status).toBe("pending");
    expect(request.currentDueDate).toBe("2026-09-01");
    expect(request.requestedDueDate).toBe("2026-09-15");
    // The installment's due date is NOT changed merely by requesting.
    expect(await installments.findDueDate(installmentId)).toBe("2026-09-01");
  });

  it("rejects a reschedule request from anyone other than the borrower", async () => {
    await expect(
      service.requestReschedule({
        installmentScheduleItemId: installmentId,
        agreementId,
        requestedDueDate: "2026-09-15",
        reason: null,
        actingUserId: OTHER_USER_ID,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("rejects a requested due date that is not after the installment's current due date", async () => {
    await expect(
      service.requestReschedule({
        installmentScheduleItemId: installmentId,
        agreementId,
        requestedDueDate: "2026-09-01", // same as the seeded current due date
        reason: null,
        actingUserId: DEBTOR_USER_ID,
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      service.requestReschedule({
        installmentScheduleItemId: installmentId,
        agreementId,
        requestedDueDate: "2026-08-15", // before the current due date
        reason: null,
        actingUserId: DEBTOR_USER_ID,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("creditor approval required to formally reschedule: approval writes the new due date; the request alone does not", async () => {
    const request = await service.requestReschedule({
      installmentScheduleItemId: installmentId,
      agreementId,
      requestedDueDate: "2026-09-15",
      reason: "paycheck delayed",
      actingUserId: DEBTOR_USER_ID,
    });

    const decided = await service.decideReschedule({
      requestId: request.id,
      decision: "approved",
      decisionReason: "ok this once",
      actingUserId: CREDITOR_USER_ID,
    });
    expect(decided.status).toBe("approved");
    expect(await installments.findDueDate(installmentId)).toBe("2026-09-15");
  });

  it("a rejected request never changes the installment's due date", async () => {
    const request = await service.requestReschedule({
      installmentScheduleItemId: installmentId,
      agreementId,
      requestedDueDate: "2026-09-15",
      reason: null,
      actingUserId: DEBTOR_USER_ID,
    });
    await service.decideReschedule({
      requestId: request.id,
      decision: "rejected",
      decisionReason: "too far out",
      actingUserId: CREDITOR_USER_ID,
    });
    expect(await installments.findDueDate(installmentId)).toBe("2026-09-01");
  });

  it("rejects a decision from anyone other than the creditor", async () => {
    const request = await service.requestReschedule({
      installmentScheduleItemId: installmentId,
      agreementId,
      requestedDueDate: "2026-09-15",
      reason: null,
      actingUserId: DEBTOR_USER_ID,
    });
    await expect(
      service.decideReschedule({ requestId: request.id, decision: "approved", decisionReason: null, actingUserId: DEBTOR_USER_ID }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("rejects deciding a request that was already decided", async () => {
    const request = await service.requestReschedule({
      installmentScheduleItemId: installmentId,
      agreementId,
      requestedDueDate: "2026-09-15",
      reason: null,
      actingUserId: DEBTOR_USER_ID,
    });
    await service.decideReschedule({ requestId: request.id, decision: "approved", decisionReason: null, actingUserId: CREDITOR_USER_ID });
    await expect(
      service.decideReschedule({ requestId: request.id, decision: "rejected", decisionReason: null, actingUserId: CREDITOR_USER_ID }),
    ).rejects.toThrow(ValidationError);
  });

  it("audits both the request and the decision", async () => {
    const request = await service.requestReschedule({
      installmentScheduleItemId: installmentId,
      agreementId,
      requestedDueDate: "2026-09-15",
      reason: null,
      actingUserId: DEBTOR_USER_ID,
    });
    await service.decideReschedule({ requestId: request.id, decision: "approved", decisionReason: null, actingUserId: CREDITOR_USER_ID });
    expect(auditRepo.events.map((e) => e.action)).toEqual(["reschedule_requested", "reschedule_approved"]);
  });

  describe("listByAgreementId (Sprint 18B Payments UI)", () => {
    it("lets either party see the agreement's reschedule requests", async () => {
      await service.requestReschedule({
        installmentScheduleItemId: installmentId,
        agreementId,
        requestedDueDate: "2026-09-15",
        reason: null,
        actingUserId: DEBTOR_USER_ID,
      });

      const asDebtor = await service.listByAgreementId(agreementId, DEBTOR_USER_ID);
      expect(asDebtor).toHaveLength(1);
      const asCreditor = await service.listByAgreementId(agreementId, CREDITOR_USER_ID);
      expect(asCreditor).toHaveLength(1);
    });

    it("denies a user who is not a party to the agreement", async () => {
      await expect(service.listByAgreementId(agreementId, OTHER_USER_ID)).rejects.toThrow(ForbiddenError);
    });
  });
});
