import { randomUUID } from "node:crypto";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { CsvImportService } from "./csvImportService";
import type {
  CsvImportBatchRecord,
  CsvImportBatchRepository,
  CsvImportBatchStatus,
  CsvImportRowDuplicateStatus,
  CsvImportRowRecord,
  CsvImportRowRepository,
  CsvImportRowValidationStatus,
  CustomerAccountResolver,
  ExistingAgreementDuplicateChecker,
} from "./csvImportService";

/** Test-only in-memory doubles for CsvImportService, mirroring src/lib/agreements/testFakes.ts's pattern. */

export class InMemoryCsvImportBatchRepository implements CsvImportBatchRepository {
  rows = new Map<string, CsvImportBatchRecord>();

  async insert(input: { businessProfileId: string; uploadedByUserId: string; fileName: string }): Promise<CsvImportBatchRecord> {
    const record: CsvImportBatchRecord = { id: randomUUID(), status: "uploaded", createdAt: new Date(), ...input };
    this.rows.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<CsvImportBatchRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async updateStatus(id: string, status: CsvImportBatchStatus): Promise<void> {
    const record = this.rows.get(id);
    if (record) record.status = status;
  }
}

export class InMemoryCsvImportRowRepository implements CsvImportRowRepository {
  rows = new Map<string, CsvImportRowRecord>();

  async insertMany(
    rows: Omit<CsvImportRowRecord, "id" | "validationStatus" | "validationErrors" | "duplicateStatus" | "createdDraftAgreementId" | "createdAt">[],
  ): Promise<CsvImportRowRecord[]> {
    const created: CsvImportRowRecord[] = [];
    for (const row of rows) {
      const record: CsvImportRowRecord = {
        id: randomUUID(),
        validationStatus: "pending",
        validationErrors: null,
        duplicateStatus: "unique",
        createdDraftAgreementId: null,
        createdAt: new Date(),
        ...row,
      };
      this.rows.set(record.id, record);
      created.push(record);
    }
    return created;
  }

  async listForBatch(batchId: string): Promise<CsvImportRowRecord[]> {
    return [...this.rows.values()].filter((r) => r.batchId === batchId).sort((a, b) => a.rowNumber - b.rowNumber);
  }

  async updateValidation(
    id: string,
    input: { validationStatus: CsvImportRowValidationStatus; validationErrors: string[] | null; duplicateStatus: CsvImportRowDuplicateStatus },
  ): Promise<void> {
    const record = this.rows.get(id);
    if (record) {
      record.validationStatus = input.validationStatus;
      record.validationErrors = input.validationErrors;
      record.duplicateStatus = input.duplicateStatus;
    }
  }

  async setCreatedDraftAgreementId(id: string, agreementId: string): Promise<void> {
    const record = this.rows.get(id);
    if (record) record.createdDraftAgreementId = agreementId;
  }
}

export class InMemoryCustomerAccountResolver implements CustomerAccountResolver {
  byEmail = new Map<string, string>(); // email -> personalProfileId

  set(email: string, personalProfileId: string): void {
    this.byEmail.set(email.toLowerCase(), personalProfileId);
  }

  async resolvePersonalProfileByEmail(email: string): Promise<string | null> {
    return this.byEmail.get(email.toLowerCase()) ?? null;
  }
}

export class InMemoryExistingAgreementDuplicateChecker implements ExistingAgreementDuplicateChecker {
  existing = new Set<string>(); // `${businessProfileId}|${debtorEmail}`

  markExisting(businessProfileId: string, debtorEmail: string): void {
    this.existing.add(`${businessProfileId}|${debtorEmail.toLowerCase()}`);
  }

  async hasExistingAgreement(businessProfileId: string, debtorEmail: string): Promise<boolean> {
    return this.existing.has(`${businessProfileId}|${debtorEmail.toLowerCase()}`);
  }
}

class InMemoryAuditEventRepositoryForCsvImport implements AuditEventRepository {
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

/** Builds a full CsvImportService test context sharing the same underlying AgreementService/profileOwners/staffService instances, exactly as production does. */
export function createTestCsvImportService() {
  const agreementCtx = createTestAgreementService();
  const batches = new InMemoryCsvImportBatchRepository();
  const rows = new InMemoryCsvImportRowRepository();
  const accountResolver = new InMemoryCustomerAccountResolver();
  const duplicateChecker = new InMemoryExistingAgreementDuplicateChecker();
  const auditRepo = new InMemoryAuditEventRepositoryForCsvImport();

  const csvImportService = new CsvImportService({
    agreementService: agreementCtx.agreementService,
    staffService: agreementCtx.staffCtx.staffService,
    profileOwners: agreementCtx.profileOwners,
    batches,
    rows,
    duplicateChecker,
    accountResolver,
    audit: new AuditService(auditRepo),
  });

  return { agreementCtx, csvImportService, batches, rows, accountResolver, duplicateChecker, auditRepo };
}
