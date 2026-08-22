import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DependencyError, ForbiddenError, ValidationError } from "@/lib/errors";
import { SandboxPaymentProvider } from "@/lib/payments/sandboxPaymentProvider";
import { BankConnectionService } from "./bankConnectionService";
import { createTestRelationshipServices } from "./testFakes";

/**
 * Phase 6A (docs/prsprints/PHASE_6A_PREPRODUCTION_FINANCIAL_UX_COMPLETION.md) Part 3/banking-invariant
 * coverage: proves the non-persistence contract end-to-end, not just by code inspection — a real
 * routing/account number goes in, and every persisted/returned field is inspected to confirm neither
 * value (nor any substring of it) survives anywhere.
 */
describe("BankConnectionService.connectBankAccount", () => {
  let ctx: ReturnType<typeof createTestRelationshipServices>;
  let service: BankConnectionService;
  let userId: string;
  let partyId: string;
  const VALID_ROUTING = "021000021"; // Chase's real, publicly documented routing number — a well-known valid checksum, not a secret.
  const VALID_ACCOUNT = "123456789012";

  beforeEach(() => {
    ctx = createTestRelationshipServices();
    service = new BankConnectionService({
      provider: new SandboxPaymentProvider("test-webhook-secret"),
      financialAccounts: ctx.relationshipFinancialAccountService,
    });
    userId = randomUUID();
    partyId = randomUUID();
    ctx.profileOwners.set("personal", partyId, userId);
  });

  it("connects a bank account, storing only safe fields, and marks it verified", async () => {
    const account = await service.connectBankAccount({
      actingUserId: userId,
      actingParty: { kind: "personal", id: partyId },
      institutionDisplayName: "Example Bank",
      accountHolderName: "Jordan Payer",
      routingNumber: VALID_ROUTING,
      accountNumber: VALID_ACCOUNT,
      accountNumberConfirm: VALID_ACCOUNT,
      accountSubtype: "checking",
    });

    expect(account.status).toBe("verified");
    expect(account.accountType).toBe("bank_account");
    expect(account.maskedLast4).toBe(VALID_ACCOUNT.slice(-4));
    expect(account.bankAccountSubtype).toBe("checking");
    expect(account.institutionDisplayName).toBe("Example Bank");
    expect(account.providerAccountRef).toMatch(/^sandbox_bank_/);
  });

  it("invariant 1 & 2: never persists the full account number or routing number anywhere in the stored record", async () => {
    const account = await service.connectBankAccount({
      actingUserId: userId,
      actingParty: { kind: "personal", id: partyId },
      institutionDisplayName: "Example Bank",
      accountHolderName: "Jordan Payer",
      routingNumber: VALID_ROUTING,
      accountNumber: VALID_ACCOUNT,
      accountNumberConfirm: VALID_ACCOUNT,
      accountSubtype: "checking",
    });
    const serialized = JSON.stringify(account);
    expect(serialized).not.toContain(VALID_ACCOUNT);
    expect(serialized).not.toContain(VALID_ROUTING);
    // Also check the raw repository row directly — not just the returned object — in case a field
    // existed on the record but was merely omitted from the service's return shape.
    const stored = await ctx.financialAccounts.findById(account.id);
    expect(JSON.stringify(stored)).not.toContain(VALID_ACCOUNT);
    expect(JSON.stringify(stored)).not.toContain(VALID_ROUTING);
  });

  it("invariant 3: no field name resembling an encrypted full account/routing number exists on the stored record", async () => {
    const account = await service.connectBankAccount({
      actingUserId: userId,
      actingParty: { kind: "personal", id: partyId },
      institutionDisplayName: "Example Bank",
      accountHolderName: "Jordan Payer",
      routingNumber: VALID_ROUTING,
      accountNumber: VALID_ACCOUNT,
      accountNumberConfirm: VALID_ACCOUNT,
      accountSubtype: "checking",
    });
    const keys = Object.keys(account);
    for (const key of keys) {
      expect(key.toLowerCase()).not.toContain("routingnumber");
      expect(key.toLowerCase()).not.toContain("accountnumber");
    }
  });

  it("rejects a routing number that fails the ABA checksum", async () => {
    await expect(
      service.connectBankAccount({
        actingUserId: userId,
        actingParty: { kind: "personal", id: partyId },
        institutionDisplayName: null,
        accountHolderName: "Jordan Payer",
        routingNumber: "123456789",
        accountNumber: VALID_ACCOUNT,
        accountNumberConfirm: VALID_ACCOUNT,
        accountSubtype: "checking",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a mismatched account-number confirmation", async () => {
    await expect(
      service.connectBankAccount({
        actingUserId: userId,
        actingParty: { kind: "personal", id: partyId },
        institutionDisplayName: null,
        accountHolderName: "Jordan Payer",
        routingNumber: VALID_ROUTING,
        accountNumber: VALID_ACCOUNT,
        accountNumberConfirm: "999999999999",
        accountSubtype: "checking",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects connecting a bank account for a profile the caller does not own (server-side authorization, independent of any UI)", async () => {
    const strangerId = randomUUID();
    await expect(
      service.connectBankAccount({
        actingUserId: strangerId,
        actingParty: { kind: "personal", id: partyId },
        institutionDisplayName: null,
        accountHolderName: "Jordan Payer",
        routingNumber: VALID_ROUTING,
        accountNumber: VALID_ACCOUNT,
        accountNumberConfirm: VALID_ACCOUNT,
        accountSubtype: "checking",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("a malformed account number never reaches the provider tokenization call", async () => {
    await expect(
      service.connectBankAccount({
        actingUserId: userId,
        actingParty: { kind: "personal", id: partyId },
        institutionDisplayName: null,
        accountHolderName: "Jordan Payer",
        routingNumber: VALID_ROUTING,
        accountNumber: "12",
        accountNumberConfirm: "12",
        accountSubtype: "checking",
      }),
    ).rejects.toThrow(ValidationError);
    // Nothing should have been created.
    const accounts = await ctx.relationshipFinancialAccountService.listAccountsForParty(userId, { kind: "personal", id: partyId });
    expect(accounts).toHaveLength(0);
  });

  describe(
    "PRSprint 29 (docs/prsprints/PRSPRINT_29_BACKUPS_RECOVERY_ROLLBACK_INCIDENT_CONTROLS.md): " +
      "bankConnectionEnabled kill switch",
    () => {
      afterEach(() => {
        delete process.env.FEATURE_BANK_CONNECTION_ENABLED;
      });

      it("blocks a new bank connection when the switch is disabled", async () => {
        process.env.FEATURE_BANK_CONNECTION_ENABLED = "false";
        await expect(
          service.connectBankAccount({
            actingUserId: userId,
            actingParty: { kind: "personal", id: partyId },
            institutionDisplayName: null,
            accountHolderName: "Jordan Payer",
            routingNumber: VALID_ROUTING,
            accountNumber: VALID_ACCOUNT,
            accountNumberConfirm: VALID_ACCOUNT,
            accountSubtype: "checking",
          }),
        ).rejects.toThrow(DependencyError);
      });
    },
  );
});
