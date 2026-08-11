import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { createFullLedgerTestContext } from "./integrationTestFakes";
import { LedgerAdminService } from "./ledgerAdminService";

describe("LedgerAdminService", () => {
  let ctx: ReturnType<typeof createFullLedgerTestContext>;
  let adminService: LedgerAdminService;
  const agreementId = randomUUID();

  beforeEach(() => {
    ctx = createFullLedgerTestContext();
    ctx.balanceCtx.terms.set(agreementId, 10_000, "USD");
    adminService = new LedgerAdminService({
      ledger: ctx.ledgerCtx.ledgerService,
      balance: ctx.balanceCtx.balanceService,
      reconciliation: ctx.reconciliationService,
    });
  });

  it("blocks a MEMBER from viewing an agreement's ledger (requirement #20)", async () => {
    await expect(adminService.getAgreementLedgerView("member", agreementId)).rejects.toThrow(ForbiddenError);
  });

  it("allows platform_admin and platform_owner to view an agreement's ledger", async () => {
    await expect(adminService.getAgreementLedgerView("platform_admin", agreementId)).resolves.toMatchObject({
      balance: { agreementId, originalPrincipalMinorUnits: 10_000 },
    });
    await expect(adminService.getAgreementLedgerView("platform_owner", agreementId)).resolves.toMatchObject({
      balance: { agreementId, originalPrincipalMinorUnits: 10_000 },
    });
  });

  it("blocks a MEMBER from listing open exceptions or triggering reconciliation", async () => {
    await expect(adminService.listOpenExceptions("member")).rejects.toThrow(ForbiddenError);
    await expect(adminService.runReconciliation("member")).rejects.toThrow(ForbiddenError);
  });

  it("blocks a MEMBER and a platform_admin from posting an adjustment; only platform_owner may (requirement #21)", async () => {
    const input = {
      paymentAttemptId: randomUUID(),
      agreementId,
      currency: "USD",
      targetAccountType: "platform_fee_revenue" as const,
      direction: "credit" as const,
      amountMinorUnits: 100,
      reason: "Manual correction for a mis-recorded fee.",
    };
    await expect(adminService.postAdjustment("member", "u1", input)).rejects.toThrow(ForbiddenError);
    await expect(adminService.postAdjustment("platform_admin", "u1", input)).rejects.toThrow(ForbiddenError);
    await expect(adminService.postAdjustment("platform_owner", "u1", input)).resolves.toMatchObject({ entryType: "admin_adjustment" });
  });

  it("has no method capable of editing or deleting a posted entry (structural proof for requirement #17's 'no unrestricted edit ledger control')", () => {
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(adminService));
    expect(methodNames).not.toContain("editEntry");
    expect(methodNames).not.toContain("updateEntry");
    expect(methodNames).not.toContain("deleteEntry");
  });
});
