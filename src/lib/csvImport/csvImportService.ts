import "server-only";
import type { AgreementService } from "@/lib/agreements/agreementService";
import type { PaymentFrequency } from "@/lib/agreements/schedule";
import { computeSchedule } from "@/lib/agreements/schedule";
import type { AuditService } from "@/lib/audit/auditService";
import { ValidationError } from "@/lib/errors";
import type { ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { StaffService } from "@/lib/staff/staffService";
import { parseCsvWithHeader } from "./csvParser";

export type CsvImportBatchStatus = "uploaded" | "validated" | "drafts_created";
export type CsvImportRowValidationStatus = "pending" | "valid" | "invalid";
export type CsvImportRowDuplicateStatus = "unique" | "duplicate_in_file" | "duplicate_existing_agreement";

export interface CsvImportBatchRecord {
  id: string;
  businessProfileId: string;
  uploadedByUserId: string;
  fileName: string;
  status: CsvImportBatchStatus;
  createdAt: Date;
}

export interface CsvImportRowRecord {
  id: string;
  batchId: string;
  rowNumber: number;
  customerEmail: string;
  customerName: string;
  invoiceReference: string | null;
  balanceMinorUnits: number;
  proposedInstallmentAmountMinorUnits: number;
  proposedFrequency: PaymentFrequency;
  proposedFirstPaymentDate: string;
  validationStatus: CsvImportRowValidationStatus;
  validationErrors: string[] | null;
  duplicateStatus: CsvImportRowDuplicateStatus;
  createdDraftAgreementId: string | null;
  createdAt: Date;
}

/** Real implementation: DrizzleCsvImportBatchRepository. */
export interface CsvImportBatchRepository {
  insert(input: { businessProfileId: string; uploadedByUserId: string; fileName: string }): Promise<CsvImportBatchRecord>;
  findById(id: string): Promise<CsvImportBatchRecord | null>;
  updateStatus(id: string, status: CsvImportBatchStatus): Promise<void>;
}

/** Real implementation: DrizzleCsvImportRowRepository. */
export interface CsvImportRowRepository {
  insertMany(
    rows: Omit<CsvImportRowRecord, "id" | "validationStatus" | "validationErrors" | "duplicateStatus" | "createdDraftAgreementId" | "createdAt">[],
  ): Promise<CsvImportRowRecord[]>;
  listForBatch(batchId: string): Promise<CsvImportRowRecord[]>;
  updateValidation(
    id: string,
    input: { validationStatus: CsvImportRowValidationStatus; validationErrors: string[] | null; duplicateStatus: CsvImportRowDuplicateStatus },
  ): Promise<void>;
  setCreatedDraftAgreementId(id: string, agreementId: string): Promise<void>;
}

/** Resolves whether a business already has a non-closed agreement with a debtor identified by email — the "against existing agreements" half of the duplicate check. */
export interface ExistingAgreementDuplicateChecker {
  hasExistingAgreement(businessProfileId: string, debtorEmail: string): Promise<boolean>;
}

/** Resolves a CSV row's customer email to an existing personal_profile id, if any — CREATE DRAFTS only ever proceeds for a matched, existing account. */
export interface CustomerAccountResolver {
  resolvePersonalProfileByEmail(email: string): Promise<string | null>;
}

export interface CsvImportServiceDeps {
  agreementService: AgreementService;
  staffService: StaffService;
  profileOwners: ProfileOwnerReader;
  batches: CsvImportBatchRepository;
  rows: CsvImportRowRepository;
  duplicateChecker: ExistingAgreementDuplicateChecker;
  accountResolver: CustomerAccountResolver;
  audit: AuditService;
}

const REQUIRED_HEADERS = ["customeremail", "customername", "balance", "installmentamount", "frequency", "firstpaymentdate"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_FREQUENCIES: PaymentFrequency[] = ["weekly", "biweekly", "monthly"];

function parseDollarsToMinorUnits(raw: string): number | null {
  const trimmed = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number.parseFloat(trimmed) * 100);
}

/**
 * Sprint 8 (docs/sprints/SPRINT_08_Workflows_CSVImports.md) CSV import: UPLOAD, VALIDATE, PREVIEW,
 * DUPLICATE CHECK, ERROR REPORT, CREATE DRAFTS. "Never bulk activate" is structural — createDrafts
 * only ever calls `AgreementService.createDraft` (status always starts at "draft"); this class has
 * no method that submits, acknowledges, accepts, or signs anything, so a debtor is guaranteed to
 * still individually authenticate/acknowledge/sign every created agreement through the normal,
 * unchanged Sprint 5/6 flow.
 */
export class CsvImportService {
  constructor(private readonly deps: CsvImportServiceDeps) {}

  async uploadBatch(input: {
    businessProfileId: string;
    actingUserId: string;
    fileName: string;
    csvContent: string;
  }): Promise<{ batch: CsvImportBatchRecord; rows: CsvImportRowRecord[] }> {
    await this.authorizeBusinessAction(input.businessProfileId, input.actingUserId);

    const table = parseCsvWithHeader(input.csvContent);
    const missingHeaders = REQUIRED_HEADERS.filter((h) => !table.headers.includes(h));
    if (missingHeaders.length > 0) {
      throw new ValidationError(`The CSV is missing required column(s): ${missingHeaders.join(", ")}.`);
    }
    if (table.rows.length === 0) {
      throw new ValidationError("The CSV contains no data rows.");
    }

    const columnIndex = (name: string) => table.headers.indexOf(name);
    const emailIdx = columnIndex("customeremail");
    const nameIdx = columnIndex("customername");
    const invoiceIdx = columnIndex("invoicereference");
    const balanceIdx = columnIndex("balance");
    const installmentIdx = columnIndex("installmentamount");
    const frequencyIdx = columnIndex("frequency");
    const dateIdx = columnIndex("firstpaymentdate");

    const batch = await this.deps.batches.insert({
      businessProfileId: input.businessProfileId,
      uploadedByUserId: input.actingUserId,
      fileName: input.fileName,
    });

    const parsedRows = table.rows.map((cells, index) => {
      const balance = parseDollarsToMinorUnits(cells[balanceIdx] ?? "");
      const installment = parseDollarsToMinorUnits(cells[installmentIdx] ?? "");
      const frequencyRaw = (cells[frequencyIdx] ?? "").trim().toLowerCase();
      return {
        batchId: batch.id,
        rowNumber: index + 1,
        customerEmail: (cells[emailIdx] ?? "").trim().toLowerCase(),
        customerName: (cells[nameIdx] ?? "").trim(),
        invoiceReference: invoiceIdx >= 0 ? (cells[invoiceIdx] ?? "").trim() || null : null,
        balanceMinorUnits: balance ?? 0,
        proposedInstallmentAmountMinorUnits: installment ?? 0,
        proposedFrequency: (VALID_FREQUENCIES.includes(frequencyRaw as PaymentFrequency) ? frequencyRaw : "monthly") as PaymentFrequency,
        proposedFirstPaymentDate: (cells[dateIdx] ?? "").trim() || "1970-01-01",
      };
    });

    const rows = await this.deps.rows.insertMany(parsedRows);
    await this.recordAudit(input.actingUserId, input.businessProfileId, "csv_import_uploaded", {
      batchId: batch.id,
      rowCount: rows.length,
    });
    return { batch, rows };
  }

  /** VALIDATE + DUPLICATE CHECK — a single pass, since the sprint's error report is per-row and duplicate status is itself a validation-relevant fact. */
  async validateBatch(batchId: string, actingUserId: string): Promise<{ batch: CsvImportBatchRecord; rows: CsvImportRowRecord[] }> {
    const batch = await this.requireBatch(batchId);
    await this.authorizeBusinessAction(batch.businessProfileId, actingUserId);

    const rows = await this.deps.rows.listForBatch(batchId);
    const seenInFile = new Map<string, number>(); // `${email}|${invoiceReference}` -> first row id seen

    for (const row of rows) {
      const errors: string[] = [];

      if (!row.customerEmail || !EMAIL_PATTERN.test(row.customerEmail)) {
        errors.push("customerEmail is missing or not a valid email address.");
      }
      if (!row.customerName) {
        errors.push("customerName is required.");
      }
      if (row.balanceMinorUnits <= 0) {
        errors.push("balance must be a positive dollar amount.");
      }
      if (row.proposedInstallmentAmountMinorUnits <= 0) {
        errors.push("installmentAmount must be a positive dollar amount.");
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.proposedFirstPaymentDate)) {
        errors.push("firstPaymentDate must be a valid date (YYYY-MM-DD).");
      } else if (errors.length === 0) {
        try {
          computeSchedule({
            currentPrincipalMinorUnits: row.balanceMinorUnits,
            firstPaymentMinorUnits: row.proposedInstallmentAmountMinorUnits,
            installmentAmountMinorUnits: row.proposedInstallmentAmountMinorUnits,
            frequency: row.proposedFrequency,
            firstPaymentDate: row.proposedFirstPaymentDate,
          });
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "The proposed plan is invalid.");
        }
      }

      // Duplicate check — within this file first.
      const key = `${row.customerEmail}|${row.invoiceReference ?? ""}`;
      let duplicateStatus: CsvImportRowDuplicateStatus = "unique";
      if (seenInFile.has(key)) {
        duplicateStatus = "duplicate_in_file";
      } else {
        seenInFile.set(key, row.rowNumber);
        if (row.customerEmail && (await this.deps.duplicateChecker.hasExistingAgreement(batch.businessProfileId, row.customerEmail))) {
          duplicateStatus = "duplicate_existing_agreement";
        }
      }

      await this.deps.rows.updateValidation(row.id, {
        validationStatus: errors.length === 0 ? "valid" : "invalid",
        validationErrors: errors.length > 0 ? errors : null,
        duplicateStatus,
      });
    }

    await this.deps.batches.updateStatus(batchId, "validated");
    await this.recordAudit(actingUserId, batch.businessProfileId, "csv_import_validated", { batchId });
    return this.getPreview(batchId, actingUserId);
  }

  /** PREVIEW + ERROR REPORT — a pure read of whatever has been stored so far. */
  async getPreview(batchId: string, actingUserId: string): Promise<{ batch: CsvImportBatchRecord; rows: CsvImportRowRecord[] }> {
    const batch = await this.requireBatch(batchId);
    await this.authorizeBusinessAction(batch.businessProfileId, actingUserId);
    const rows = await this.deps.rows.listForBatch(batchId);
    return { batch, rows };
  }

  /**
   * CREATE DRAFTS. Only rows that are valid, non-duplicate, AND match an existing account become a
   * real (always `draft`-status) agreement — a row whose customer has no account yet is left
   * un-drafted with a clear explanatory note, never silently skipped and never invented an account
   * for (this project has no invitation system yet; building one is out of this sprint's scope).
   */
  async createDrafts(batchId: string, actingUserId: string): Promise<{ createdCount: number; skippedNoAccountCount: number; totalRows: number }> {
    const batch = await this.requireBatch(batchId);
    await this.authorizeBusinessAction(batch.businessProfileId, actingUserId);
    if (batch.status !== "validated") {
      throw new ValidationError("This batch must be validated before drafts can be created.");
    }

    const rows = await this.deps.rows.listForBatch(batchId);
    let createdCount = 0;
    let skippedNoAccountCount = 0;

    for (const row of rows) {
      if (row.validationStatus !== "valid" || row.duplicateStatus !== "unique" || row.createdDraftAgreementId) {
        continue;
      }
      const personalProfileId = await this.deps.accountResolver.resolvePersonalProfileByEmail(row.customerEmail);
      if (!personalProfileId) {
        skippedNoAccountCount++;
        await this.deps.rows.updateValidation(row.id, {
          validationStatus: row.validationStatus,
          validationErrors: [...(row.validationErrors ?? []), "No matching account found for this email — a draft could not be created yet."],
          duplicateStatus: row.duplicateStatus,
        });
        continue;
      }

      const result = await this.deps.agreementService.createDraft({
        creatorUserId: actingUserId,
        creditor: { kind: "business", id: batch.businessProfileId },
        debtor: { kind: "personal", id: personalProfileId },
        category: "business_receivable",
        description: row.invoiceReference
          ? `Imported receivable for ${row.customerName} (invoice ${row.invoiceReference}).`
          : `Imported receivable for ${row.customerName}.`,
        originalAmountMinorUnits: row.balanceMinorUnits,
        previousPaymentsMinorUnits: 0,
        firstPaymentMinorUnits: row.proposedInstallmentAmountMinorUnits,
        installmentAmountMinorUnits: row.proposedInstallmentAmountMinorUnits,
        frequency: row.proposedFrequency,
        firstPaymentDate: row.proposedFirstPaymentDate,
        feeAllocation: "debtor_pays",
        earlyPayoffTerms: "No penalty for early payoff.",
        hardshipRules: "The debtor may request hardship relief; no interest or penalty is added.",
        partialPaymentRules: "Partial payments require creditor approval.",
        settlementRules: "Settlement may be proposed by either party.",
        disputeProcedure: "Disputes are handled per platform policy.",
        supportingEvidenceReferences: row.invoiceReference ? [row.invoiceReference] : undefined,
      });
      await this.deps.rows.setCreatedDraftAgreementId(row.id, result.agreement.id);
      createdCount++;
    }

    await this.deps.batches.updateStatus(batchId, "drafts_created");
    await this.recordAudit(actingUserId, batch.businessProfileId, "csv_import_drafts_created", {
      batchId,
      createdCount,
      skippedNoAccountCount,
    });
    return { createdCount, skippedNoAccountCount, totalRows: rows.length };
  }

  private async requireBatch(batchId: string): Promise<CsvImportBatchRecord> {
    const batch = await this.deps.batches.findById(batchId);
    if (!batch) throw new ValidationError("Import batch not found.");
    return batch;
  }

  /** Owner or an active staff member with `create_agreement` — mirrors AgreementService's own business-side authorization without depending on it (CSV import is a single-business action, not a two-party agreement action). */
  private async authorizeBusinessAction(businessProfileId: string, actingUserId: string): Promise<void> {
    const ownerUserId = await this.deps.profileOwners.getOwnerUserId("business", businessProfileId);
    if (ownerUserId === actingUserId) return;
    if (!ownerUserId) throw new ValidationError("Business profile not found.");
    await this.deps.staffService.requireCapability(businessProfileId, actingUserId, "create_agreement");
  }

  private async recordAudit(actorUserId: string, businessProfileId: string, action: string, newValue: unknown): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "business_staff",
      profileKind: "business",
      profileId: businessProfileId,
      agreementId: null,
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
    });
  }
}
