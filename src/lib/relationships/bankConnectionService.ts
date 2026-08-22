import "server-only";
import type { MfaService } from "@/lib/auth/mfaService";
import { DependencyError, StepUpRequiredError, ValidationError } from "@/lib/errors";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { accountNumbersMatch, isValidAccountNumber, isValidRoutingNumber } from "@/lib/finance/bankAccountValidation";
import type { PaymentProvider } from "@/lib/payments/paymentProvider";
import type { PartyRef } from "./relationshipInvitationService";
import type { BankAccountSubtype, FinancialAccountRecord, RelationshipFinancialAccountService } from "./relationshipFinancialAccountService";

/**
 * Phase 6A (docs/prsprints/PHASE_6A_PREPRODUCTION_FINANCIAL_UX_COMPLETION.md) Part 3: the
 * production-quality bank-account connection orchestration — "Paid2You should operate as a
 * middleman/orchestrator, not a bank-credential vault." This is the one place in the codebase that
 * ever receives a raw routing/account number (the documented fallback architecture — no live
 * financial provider has been selected, so a provider-hosted tokenized widget does not exist yet; see
 * docs/PRODUCTION_PROVIDER_READINESS.md). The raw values live only in this method's own local
 * variables and the single `tokenizeBankAccount` call below — never assigned to any field, never
 * returned, never logged, never passed to `RelationshipFinancialAccountService.addAccount` (which
 * receives only the provider's safe token + non-sensitive display metadata, exactly like every other
 * `financial_account` insertion path in this codebase already required — see that service's own doc
 * comment: "This route never sees or logs a raw account/routing number").
 *
 * Server-side validation is the real gate (client-side validation is UX assistance only, per this
 * phase's own explicit rule) — `isValidRoutingNumber`/`isValidAccountNumber`/`accountNumbersMatch` run
 * again here regardless of what the client already checked.
 */
export class BankConnectionService {
  constructor(
    private readonly deps: {
      provider: PaymentProvider;
      financialAccounts: RelationshipFinancialAccountService;
      mfa: MfaService;
    },
  ) {}

  async connectBankAccount(input: {
    actingUserId: string;
    actingSessionId: string;
    actingParty: PartyRef;
    institutionDisplayName: string | null;
    accountHolderName: string;
    routingNumber: string;
    accountNumber: string;
    accountNumberConfirm: string;
    accountSubtype: BankAccountSubtype;
  }): Promise<FinancialAccountRecord> {
    // PRSprint 29 (docs/prsprints/PRSPRINT_29_BACKUPS_RECOVERY_ROLLBACK_INCIDENT_CONTROLS.md):
    // bank-linking kill switch — an operator can disable new bank connections mid-incident (e.g. a
    // suspected tokenization-provider issue) via FEATURE_BANK_CONNECTION_ENABLED=false, with no
    // deploy required and no effect on already-connected accounts.
    if (!isFeatureEnabled("bankConnectionEnabled")) {
      throw new DependencyError("Bank account connection is temporarily unavailable. Please try again shortly.");
    }
    // SPRINT_19_FraudRisk_SecurityHardening: authorize the acting party BEFORE requiring step-up
    // (mirrors SignatureService.sign's ordering) — a stranger to this profile gets ForbiddenError
    // without ever being prompted for MFA. Only after that does docs/SECURITY_MODEL.md threat #16's
    // (payout redirection) elevated-MFA requirement apply: this is the one place in the codebase
    // that ever receives a raw routing/account number.
    await this.deps.financialAccounts.requireOwnedParty(input.actingUserId, input.actingParty);
    const stepUpOk = await this.deps.mfa.requireStepUp({
      userId: input.actingUserId,
      sessionId: input.actingSessionId,
      action: "connect_bank_account",
    });
    if (!stepUpOk) {
      throw new StepUpRequiredError(
        "Step-up verification is required before connecting a bank account. Please complete a fresh verification challenge and try again.",
      );
    }
    if (!input.accountHolderName.trim()) {
      throw new ValidationError("Account holder name is required.");
    }
    if (!isValidRoutingNumber(input.routingNumber)) {
      throw new ValidationError("That routing number does not look valid. Double-check the 9 digits and try again.");
    }
    if (!isValidAccountNumber(input.accountNumber)) {
      throw new ValidationError("Account number must be between 4 and 17 digits.");
    }
    if (!accountNumbersMatch(input.accountNumber, input.accountNumberConfirm)) {
      throw new ValidationError("Account number and confirmation do not match.");
    }

    // Fallback-architecture exchange (see this class's own doc comment): the raw values are read
    // exactly once here and never referenced again after this call returns.
    const tokenized = await this.deps.provider.tokenizeBankAccount({
      profile: { profileKind: input.actingParty.kind, profileId: input.actingParty.id },
      routingNumber: input.routingNumber,
      accountNumber: input.accountNumber,
      accountSubtype: input.accountSubtype,
      accountHolderName: input.accountHolderName,
    });

    const account = await this.deps.financialAccounts.addAccount({
      actingUserId: input.actingUserId,
      actingParty: input.actingParty,
      accountType: "bank_account",
      providerName: this.deps.provider.providerName,
      providerAccountRef: tokenized.providerAccountRef,
      maskedLast4: tokenized.maskedLast4,
      institutionDisplayName: input.institutionDisplayName,
      bankAccountSubtype: input.accountSubtype,
    });

    // The sandbox provider validates/tokenizes synchronously (mirroring a real provider's
    // instant-auth capability, e.g. Plaid Instant Auth) — a genuinely async-verifying production
    // provider would instead leave the account pending and let its own connector call
    // applyVerificationResult later, exactly as documented on that method.
    if (account.status === "pending_verification") {
      return this.deps.financialAccounts.applyVerificationResult(account.id, "verified");
    }
    return account;
  }
}
