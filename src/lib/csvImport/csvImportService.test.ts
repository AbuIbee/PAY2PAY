import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestCsvImportService } from "./testFakes";

// Agreement Lifecycle V2 UAT (Defect 5): AgreementService.createDraft now rejects a past
// firstPaymentDate server-side, so this must stay in the future regardless of when the suite runs.
const FUTURE_DATE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const VALID_CSV = [
  "customerEmail,customerName,invoiceReference,balance,installmentAmount,frequency,firstPaymentDate",
  `alice@example.com,Alice Smith,INV-100,1200.00,200.00,monthly,${FUTURE_DATE}`,
  `bob@example.com,Bob Jones,INV-101,600.00,150.00,monthly,${FUTURE_DATE}`,
].join("\n");

describe("CsvImportService", () => {
  let ctx: ReturnType<typeof createTestCsvImportService>;

  async function seedBusiness(): Promise<{ businessId: string; ownerId: string }> {
    const ownerId = randomUUID();
    const businessId = randomUUID();
    ctx.agreementCtx.profileOwners.set("business", businessId, ownerId);
    return { businessId, ownerId };
  }

  beforeEach(() => {
    ctx = createTestCsvImportService();
  });

  describe("import validation", () => {
    it("uploads a well-formed CSV and validates every row as valid", async () => {
      const { businessId, ownerId } = await seedBusiness();
      const { batch, rows } = await ctx.csvImportService.uploadBatch({
        businessProfileId: businessId,
        actingUserId: ownerId,
        fileName: "customers.csv",
        csvContent: VALID_CSV,
      });
      expect(batch.status).toBe("uploaded");
      expect(rows).toHaveLength(2);

      const validated = await ctx.csvImportService.validateBatch(batch.id, ownerId);
      expect(validated.batch.status).toBe("validated");
      expect(validated.rows.every((r) => r.validationStatus === "valid")).toBe(true);
    });

    it("rejects a CSV missing a required column", async () => {
      const { businessId, ownerId } = await seedBusiness();
      const badCsv = "customerEmail,customerName\nalice@example.com,Alice";
      await expect(
        ctx.csvImportService.uploadBatch({ businessProfileId: businessId, actingUserId: ownerId, fileName: "bad.csv", csvContent: badCsv }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a CSV with no data rows", async () => {
      const { businessId, ownerId } = await seedBusiness();
      const headerOnly = "customerEmail,customerName,invoiceReference,balance,installmentAmount,frequency,firstPaymentDate";
      await expect(
        ctx.csvImportService.uploadBatch({ businessProfileId: businessId, actingUserId: ownerId, fileName: "empty.csv", csvContent: headerOnly }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("monetary parsing boundary (PRSprint 17 — docs/prsprints/PHASE_5_PREFLIGHT_FINDINGS.md §7 item 7)", () => {
    it("converts dollar strings to exact integer minor units with no rounding drift, including $ and comma formatting", async () => {
      const { businessId, ownerId } = await seedBusiness();
      const csv = [
        "customerEmail,customerName,invoiceReference,balance,installmentAmount,frequency,firstPaymentDate",
        "penny@example.com,Penny Cents,INV-P,0.01,0.01,monthly,2026-03-01",
        "dollar@example.com,Dollar Amt,INV-D,1234567.89,100.00,monthly,2026-03-01",
        "formatted@example.com,Formatted Amt,INV-F,\"$1,200.00\",\"$200.00\",monthly,2026-03-01",
      ].join("\n");
      const { rows } = await ctx.csvImportService.uploadBatch({ businessProfileId: businessId, actingUserId: ownerId, fileName: "boundary.csv", csvContent: csv });
      // Exact — never off by a cent from an accumulated floating-point remainder.
      expect(rows[0]?.balanceMinorUnits).toBe(1);
      expect(rows[1]?.balanceMinorUnits).toBe(123_456_789);
      expect(rows[2]?.balanceMinorUnits).toBe(120_000);
      expect(rows[2]?.proposedInstallmentAmountMinorUnits).toBe(20_000);
    });

    it("rejects malformed monetary input (more than 2 decimal places, negative, non-numeric) rather than silently coercing it", async () => {
      const { businessId, ownerId } = await seedBusiness();
      const csv = [
        "customerEmail,customerName,invoiceReference,balance,installmentAmount,frequency,firstPaymentDate",
        "threeDecimals@example.com,Three Decimals,INV-1,100.005,50.00,monthly,2026-03-01",
        "negative@example.com,Negative,INV-2,-100.00,50.00,monthly,2026-03-01",
        "nonnumeric@example.com,Non Numeric,INV-3,not-a-number,50.00,monthly,2026-03-01",
      ].join("\n");
      const { batch } = await ctx.csvImportService.uploadBatch({ businessProfileId: businessId, actingUserId: ownerId, fileName: "malformed.csv", csvContent: csv });
      const { rows } = await ctx.csvImportService.validateBatch(batch.id, ownerId);
      // Every malformed balance parses to null -> defaults to 0 -> fails the ">0" check explicitly,
      // rather than silently truncating/rounding to some other dollar amount.
      for (const row of rows) {
        expect(row.balanceMinorUnits).toBe(0);
        expect(row.validationStatus).toBe("invalid");
        expect(row.validationErrors).toContain("balance must be a positive dollar amount.");
      }
    });
  });

  describe("invalid row", () => {
    it("flags a row with a bad email, non-positive balance, and invalid date, without blocking other rows", async () => {
      const { businessId, ownerId } = await seedBusiness();
      const csv = [
        "customerEmail,customerName,invoiceReference,balance,installmentAmount,frequency,firstPaymentDate",
        "not-an-email,Bad Row,INV-1,-50.00,0,monthly,not-a-date",
        "carol@example.com,Carol Lee,INV-2,900.00,300.00,monthly,2026-03-01",
      ].join("\n");
      const { batch } = await ctx.csvImportService.uploadBatch({ businessProfileId: businessId, actingUserId: ownerId, fileName: "mixed.csv", csvContent: csv });
      const { rows } = await ctx.csvImportService.validateBatch(batch.id, ownerId);

      const badRow = rows.find((r) => r.rowNumber === 1);
      expect(badRow?.validationStatus).toBe("invalid");
      expect(badRow?.validationErrors?.length).toBeGreaterThan(0);
      expect(badRow?.validationErrors?.some((e) => e.toLowerCase().includes("email"))).toBe(true);

      const goodRow = rows.find((r) => r.rowNumber === 2);
      expect(goodRow?.validationStatus).toBe("valid");
    });
  });

  describe("duplicate handling", () => {
    it("flags a second row with the same customer+invoice as duplicate_in_file", async () => {
      const { businessId, ownerId } = await seedBusiness();
      const csv = [
        "customerEmail,customerName,invoiceReference,balance,installmentAmount,frequency,firstPaymentDate",
        "dana@example.com,Dana K,INV-9,500.00,100.00,monthly,2026-03-01",
        "dana@example.com,Dana K,INV-9,500.00,100.00,monthly,2026-03-01",
      ].join("\n");
      const { batch } = await ctx.csvImportService.uploadBatch({ businessProfileId: businessId, actingUserId: ownerId, fileName: "dupe.csv", csvContent: csv });
      const { rows } = await ctx.csvImportService.validateBatch(batch.id, ownerId);

      expect(rows.find((r) => r.rowNumber === 1)?.duplicateStatus).toBe("unique");
      expect(rows.find((r) => r.rowNumber === 2)?.duplicateStatus).toBe("duplicate_in_file");
    });

    it("flags a row matching an existing agreement as duplicate_existing_agreement", async () => {
      const { businessId, ownerId } = await seedBusiness();
      ctx.duplicateChecker.markExisting(businessId, "erin@example.com");
      const csv = [
        "customerEmail,customerName,invoiceReference,balance,installmentAmount,frequency,firstPaymentDate",
        "erin@example.com,Erin M,INV-5,700.00,100.00,monthly,2026-03-01",
      ].join("\n");
      const { batch } = await ctx.csvImportService.uploadBatch({ businessProfileId: businessId, actingUserId: ownerId, fileName: "existing.csv", csvContent: csv });
      const { rows } = await ctx.csvImportService.validateBatch(batch.id, ownerId);
      expect(rows[0]?.duplicateStatus).toBe("duplicate_existing_agreement");
    });
  });

  describe("no bulk activation", () => {
    it("creates only draft-status agreements for matched, valid, unique rows — never advances them", async () => {
      const { businessId, ownerId } = await seedBusiness();
      const alicePersonalId = randomUUID();
      ctx.accountResolver.set("alice@example.com", alicePersonalId);
      // Bob has no matching account.

      const { batch } = await ctx.csvImportService.uploadBatch({ businessProfileId: businessId, actingUserId: ownerId, fileName: "customers.csv", csvContent: VALID_CSV });
      await ctx.csvImportService.validateBatch(batch.id, ownerId);
      const result = await ctx.csvImportService.createDrafts(batch.id, ownerId);

      expect(result.createdCount).toBe(1);
      expect(result.skippedNoAccountCount).toBe(1);
      expect(result.totalRows).toBe(2);

      const rows = (await ctx.csvImportService.getPreview(batch.id, ownerId)).rows;
      const aliceRow = rows.find((r) => r.customerEmail === "alice@example.com");
      expect(aliceRow?.createdDraftAgreementId).toBeTruthy();
      const createdAgreement = await ctx.agreementCtx.agreements.findById(aliceRow!.createdDraftAgreementId!);
      expect(createdAgreement?.status).toBe("draft"); // never advanced — the debtor must still individually submit/acknowledge/sign

      const bobRow = rows.find((r) => r.customerEmail === "bob@example.com");
      expect(bobRow?.createdDraftAgreementId).toBeNull();
      expect(bobRow?.validationErrors?.some((e) => e.includes("No matching account"))).toBe(true);
    });

    it("rejects creating drafts before the batch has been validated", async () => {
      const { businessId, ownerId } = await seedBusiness();
      const { batch } = await ctx.csvImportService.uploadBatch({ businessProfileId: businessId, actingUserId: ownerId, fileName: "customers.csv", csvContent: VALID_CSV });
      await expect(ctx.csvImportService.createDrafts(batch.id, ownerId)).rejects.toThrow(ValidationError);
    });

    it("CsvImportService exposes no method that submits, acknowledges, or signs anything", () => {
      const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.csvImportService));
      const dangerous = methodNames.filter((name) => /submit|acknowledge|sign|accept|activate/i.test(name));
      expect(dangerous).toEqual([]);
    });
  });

  describe("tenant isolation", () => {
    it("rejects a user unrelated to the business from uploading, validating, previewing, or creating drafts", async () => {
      const { businessId, ownerId } = await seedBusiness();
      const stranger = randomUUID();

      await expect(
        ctx.csvImportService.uploadBatch({ businessProfileId: businessId, actingUserId: stranger, fileName: "x.csv", csvContent: VALID_CSV }),
      ).rejects.toThrow(ForbiddenError);

      const { batch } = await ctx.csvImportService.uploadBatch({ businessProfileId: businessId, actingUserId: ownerId, fileName: "x.csv", csvContent: VALID_CSV });
      await expect(ctx.csvImportService.validateBatch(batch.id, stranger)).rejects.toThrow(ForbiddenError);
      await expect(ctx.csvImportService.getPreview(batch.id, stranger)).rejects.toThrow(ForbiddenError);
      await expect(ctx.csvImportService.createDrafts(batch.id, stranger)).rejects.toThrow(ForbiddenError);
    });

    it("a staff member with create_agreement can act; one without it cannot", async () => {
      const { businessId } = await seedBusiness();
      const authorizedStaff = randomUUID();
      const unauthorizedStaff = randomUUID();
      ctx.agreementCtx.staffCtx.staffMembers.seed({ businessProfileId: businessId, userId: authorizedStaff, role: "manager" });
      ctx.agreementCtx.staffCtx.staffMembers.seed({ businessProfileId: businessId, userId: unauthorizedStaff, role: "accountant_viewer" });

      await expect(
        ctx.csvImportService.uploadBatch({ businessProfileId: businessId, actingUserId: unauthorizedStaff, fileName: "x.csv", csvContent: VALID_CSV }),
      ).rejects.toThrow(ForbiddenError);

      const { batch } = await ctx.csvImportService.uploadBatch({ businessProfileId: businessId, actingUserId: authorizedStaff, fileName: "x.csv", csvContent: VALID_CSV });
      expect(batch.uploadedByUserId).toBe(authorizedStaff);
    });
  });
});
