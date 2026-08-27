import "server-only";
import { randomUUID } from "node:crypto";
import type { AuditService } from "@/lib/audit/auditService";
import type { MfaService } from "@/lib/auth/mfaService";
import { ForbiddenError, StepUpRequiredError, ValidationError, ConflictError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { RiskEventService } from "@/lib/risk/riskEventService";
import type { Capability } from "@/lib/staff/capabilities";
import type { StaffService } from "@/lib/staff/staffService";
import type { NotificationService } from "@/lib/notify/notificationService";
import type { ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { PlatformRole } from "@/lib/auth/authService";
import type { PartyRole } from "@/lib/agreements/agreementService";
import { isAdminRole } from "@/lib/admin/capabilities";
import type { PartyRef } from "./relationshipInvitationService";
import type { RelationshipRepository, RelationshipParticipantRecord, RelationshipParticipantRepository } from "./relationshipService";

export type FinancialAccountType = "bank_account" | "debit_card";
export type BankAccountSubtype = "checking" | "savings";
export type FinancialAccountStatus = "pending_verification" | "verified" | "failed" | "disabled";
export type FinancialAccountUsage = "funding" | "payout";
export type RelationshipFinancialAccountAssignmentStatus = "active" | "superseded";

export interface FinancialAccountRecord {
  id: string;
  individualProfileId: string | null;
  organizationId: string | null;
  accountType: FinancialAccountType;
  providerName: string;
  providerAccountRef: string;
  maskedLast4: string | null;
  institutionDisplayName: string | null;
  cardExpiryMonth: number | null;
  cardExpiryYear: number | null;
  cardBrand: string | null;
  bankAccountSubtype: BankAccountSubtype | null;
  status: FinancialAccountStatus;
  addedByUserId: string;
  createdAt: Date;
  verifiedAt: Date | null;
  disabledAt: Date | null;
  updatedAt: Date;
}

export interface RelationshipFinancialAccountAssignmentRecord {
  id: string;
  relationshipId: string;
  relationshipParticipantId: string;
  financialAccountId: string;
  usage: FinancialAccountUsage;
  status: RelationshipFinancialAccountAssignmentStatus;
  selectedByUserId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  supersededBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RelationshipFinancialAccountAssignmentWithAccount extends RelationshipFinancialAccountAssignmentRecord {
  financialAccount: FinancialAccountRecord;
}

/**
 * Privacy remediation (mutual-cancellation/missing-connection incident, connection P2P-EZ2R-V3MM):
 * the participant-facing view of a relationship's funding/payout slots. A relationship has exactly two
 * slots (`funding`, `payout`) and — per the required ownership model — exactly one of them is "mine"
 * for any given caller (debtor owns funding, creditor owns payout; see `usageForRole`). Full bank
 * details (`account`) are populated ONLY for the caller's own slot; the counterparty's slot exposes
 * nothing beyond `ready` (an active, verified account is assigned) — never a bank name, last four,
 * account type, or financial-account id. This is enforced here, server-side, precisely so no UI layer
 * can accidentally render what this method never even returns.
 */
export interface RelationshipAccountSlotView {
  usage: FinancialAccountUsage;
  /** Whether this slot belongs to the caller's own participation in the relationship. */
  mine: boolean;
  assignmentId: string | null;
  status: RelationshipFinancialAccountAssignmentStatus | null;
  /** True iff an active assignment occupies this slot with a verified account — the only thing the counterparty's slot ever reveals. */
  ready: boolean;
  /** Populated only when `mine` is true; always null for the counterparty's slot. */
  account: {
    id: string;
    accountType: FinancialAccountType;
    maskedLast4: string | null;
    institutionDisplayName: string | null;
    status: FinancialAccountStatus;
  } | null;
}

/**
 * Admin connector (Phase 37) view: deliberately omits `providerAccountRef` entirely (a reusable
 * provider token — "do not expose... provider secret") even though it is never a raw account/routing
 * number or PAN. Everything else here is exactly what Phase 37 names as permitted: financial-account
 * status and masked account information.
 */
export interface AdminFinancialAccountAssignmentView {
  assignmentId: string;
  usage: FinancialAccountUsage;
  assignmentStatus: RelationshipFinancialAccountAssignmentStatus;
  accountType: FinancialAccountType;
  accountStatus: FinancialAccountStatus;
  maskedLast4: string | null;
  institutionDisplayName: string | null;
  bankAccountSubtype: BankAccountSubtype | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** Real implementation: DrizzleFinancialAccountRepository. Owns only the party-scoped `financial_account` table — never the assignment table (see RelationshipFinancialAccountRepository below). */
export interface FinancialAccountRepository {
  insert(input: {
    individualProfileId: string | null;
    organizationId: string | null;
    accountType: FinancialAccountType;
    providerName: string;
    providerAccountRef: string;
    maskedLast4: string | null;
    institutionDisplayName: string | null;
    cardExpiryMonth: number | null;
    cardExpiryYear: number | null;
    cardBrand: string | null;
    bankAccountSubtype: BankAccountSubtype | null;
    addedByUserId: string;
  }): Promise<FinancialAccountRecord>;
  findById(id: string): Promise<FinancialAccountRecord | null>;
  listForParty(individualProfileId: string | null, organizationId: string | null): Promise<FinancialAccountRecord[]>;
  markVerified(id: string, verifiedAt: Date): Promise<FinancialAccountRecord>;
  markFailed(id: string): Promise<FinancialAccountRecord>;
  markDisabled(id: string, disabledAt: Date): Promise<FinancialAccountRecord>;
}

/** Real implementation: DrizzleRelationshipFinancialAccountRepository. Owns only the `relationship_financial_account` assignment table. */
export interface RelationshipFinancialAccountRepository {
  insertAssignment(input: {
    /**
     * SPRINT_19_FraudRisk_SecurityHardening: optional, application-generated id. `replaceAccount`
     * needs the new row's id BEFORE inserting it, to mark the old row superseded-by-it first (see
     * that method's own doc comment for why the insert-then-supersede order this repository
     * previously required would violate the DB's own partial unique index on every real replacement,
     * not just a race). Omitted by `assignAccount` (no prior row to supersede) — the DB default
     * (`gen_random_uuid()`) applies as before.
     */
    id?: string;
    relationshipId: string;
    relationshipParticipantId: string;
    financialAccountId: string;
    usage: FinancialAccountUsage;
    selectedByUserId: string;
  }): Promise<RelationshipFinancialAccountAssignmentRecord>;
  findActiveAssignment(relationshipId: string, usage: FinancialAccountUsage): Promise<RelationshipFinancialAccountAssignmentWithAccount | null>;
  markSuperseded(id: string, supersededBy: string): Promise<RelationshipFinancialAccountAssignmentRecord>;
  listForRelationship(relationshipId: string): Promise<RelationshipFinancialAccountAssignmentWithAccount[]>;
  /** Manual UAT remediation (#10): every relationship currently using this account as an *active* funding/payout slot, regardless of relationship — the removal guard's source of truth for "would this break an in-flight transaction." */
  listActiveAssignmentsForAccount(financialAccountId: string): Promise<RelationshipFinancialAccountAssignmentRecord[]>;
}

/** Narrow interface onto RelationshipService's own read-time-sync method — avoids depending on that class's entire surface (this codebase's established interface-segregation precedent, e.g. MandateReader). RelationshipService itself satisfies this structurally. */
export interface RelationshipStatusSyncer {
  syncFromFinancialAccounts(relationshipId: string): Promise<void>;
}

export interface RelationshipFinancialAccountServiceDeps {
  financialAccounts: FinancialAccountRepository;
  assignments: RelationshipFinancialAccountRepository;
  relationships: RelationshipRepository;
  participants: RelationshipParticipantRepository;
  relationshipSync: RelationshipStatusSyncer;
  profileOwners: ProfileOwnerReader;
  staffService: StaffService;
  notifications: NotificationService;
  audit: AuditService;
  mfa: MfaService;
  riskEvents: RiskEventService;
}

/**
 * `change_payout_configuration` (Sprint 4's own fixed 13-capability list) is the closest existing
 * capability to "manage this organization's financial accounts" — there is no dedicated
 * "manage_financial_accounts" capability in that fixed list, and this sprint's own instruction is to
 * reuse existing capabilities rather than invent competing ones. Used for every business-party action
 * in this class (add/assign/replace), for both funding and payout accounts alike — the fixed list does
 * not distinguish the two.
 */
const FINANCIAL_ACCOUNT_CAPABILITY: Capability = "change_payout_configuration";

/**
 * REQUIRED OWNERSHIP MODEL (connection P2P-EZ2R-V3MM remediation): for the two-principal debtor/
 * creditor relationships this codebase's `financial_account_usage` enum supports today, the funding
 * slot ("where money is pulled from") is always the debtor's own, and the payout slot ("where money is
 * delivered") is always the creditor's own — never a shared, either-party-assignable connection-level
 * slot. This is the single source of truth `requireUsageMatchesRole` enforces before any assignment
 * mutation, and `getRelationshipAccountsForParticipant` reads it to decide which slot is "mine."
 */
function usageForRole(role: PartyRole): FinancialAccountUsage {
  return role === "debtor" ? "funding" : "payout";
}

/**
 * Sprint 18A §14–§19: the party-owned financial account layer and its relationship-scoped assignment.
 * Deliberately does not re-implement Sprint 11 (ACH mandate) or Sprint 12 (debit card) verification —
 * `applyVerificationResult` is the one seam those connectors call into once *their own* provider/
 * sandbox verification completes, matching Phase 16's "reuse the existing verification mechanism, do
 * not invent another verification framework."
 *
 * Debit-card connector (Phase 21) — remediation pass: `financial_account` now carries optional
 * `cardExpiryMonth`/`cardExpiryYear`/`cardBrand` columns (required by `addAccount` when `accountType`
 * is `debit_card`, see that method's own doc comment), so `RelationshipService.linkAgreement` can
 * auto-register a real Sprint 12 `debit_card_method` row the same way it auto-authorizes an ACH
 * mandate — via `CardMethodReader.registerFromFinancialAccount`, which delegates entirely to
 * `DebitCardMethodService.registerCard` (no card logic reimplemented here). This relationship layer
 * never stores a raw PAN/CVV — only the same opaque `providerAccountRef` token every other account
 * type uses, plus non-sensitive last4/expiry/brand display metadata.
 *
 * Account replacement (`replaceAccount`) never overwrites the prior assignment row — it inserts a new
 * `active` row and marks the previous one `superseded` via `supersededBy`, preserving full history
 * ("do not overwrite history", Phase 18). Mutual/counterparty approval is deliberately NOT required to
 * replace a funding or payout account: this mirrors Sprint 11's `AchMandateService.handleBankChange`
 * and Sprint 12's debit-card replacement, neither of which requires counterparty sign-off to change a
 * payer's or payee's own payment method — only the assigned participant (or their authorized staff)
 * may act, exactly as enforced below.
 */
export class RelationshipFinancialAccountService {
  constructor(private readonly deps: RelationshipFinancialAccountServiceDeps) {}

  /**
   * Debit-card connector (Phase 21) remediation: when `accountType` is `debit_card`,
   * `maskedLast4`/`cardExpiryMonth`/`cardExpiryYear` are required (mirroring `debit_card_method`'s own
   * NOT NULL columns exactly) — a relationship-driven card registration must supply real values, never
   * a placeholder, so this validation happens here rather than deferring to a downstream failure at
   * `linkAgreement` time. `cardBrand` stays optional, matching `debit_card_method.card_brand`'s own
   * nullable column.
   */
  async addAccount(input: {
    actingUserId: string;
    actingParty: PartyRef;
    accountType: FinancialAccountType;
    providerName: string;
    providerAccountRef: string;
    maskedLast4: string | null;
    institutionDisplayName: string | null;
    cardExpiryMonth?: number | null;
    cardExpiryYear?: number | null;
    cardBrand?: string | null;
    bankAccountSubtype?: BankAccountSubtype | null;
  }): Promise<FinancialAccountRecord> {
    await this.authorizeParty(input.actingUserId, input.actingParty);
    if (!input.providerAccountRef.trim()) {
      throw new ValidationError("A provider account reference is required.");
    }
    if (input.accountType === "debit_card") {
      if (!input.maskedLast4 || !input.cardExpiryMonth || !input.cardExpiryYear) {
        throw new ValidationError("A debit card account requires maskedLast4, cardExpiryMonth, and cardExpiryYear.");
      }
      if (!Number.isInteger(input.cardExpiryMonth) || input.cardExpiryMonth < 1 || input.cardExpiryMonth > 12) {
        throw new ValidationError("cardExpiryMonth must be an integer between 1 and 12.");
      }
      if (!Number.isInteger(input.cardExpiryYear) || input.cardExpiryYear < 2000) {
        throw new ValidationError("cardExpiryYear must be a valid 4-digit year.");
      }
    }

    // PRSprint 22 (docs/prsprints/PRSPRINT_22_KYC_KYB_FINANCIAL_ACCOUNT_PROVISIONING.md): duplicate
    // provisioning protection — a retried "connect this bank account/card" request (double-click,
    // network retry, a client resubmitting after a slow response) carries the exact same
    // provider-issued token as the original. Without this check, each retry would silently insert a
    // second `financial_account` row for what is really the same underlying account, fragmenting
    // history and letting a stale `disabled` copy sit alongside a live one. Idempotent-by-return
    // (mirrors this codebase's established insert-then-recheck precedent, e.g. PaymentService.
    // reserveAttempt): a disabled account never blocks re-adding the same token — a party who
    // disabled an account and now wants to reconnect it gets a fresh row, not a resurrected old one.
    const existingForParty = await this.deps.financialAccounts.listForParty(
      input.actingParty.kind === "personal" ? input.actingParty.id : null,
      input.actingParty.kind === "business" ? input.actingParty.id : null,
    );
    const duplicate = existingForParty.find((a) => a.providerAccountRef === input.providerAccountRef && a.status !== "disabled");
    if (duplicate) return duplicate;

    const account = await this.deps.financialAccounts.insert({
      individualProfileId: input.actingParty.kind === "personal" ? input.actingParty.id : null,
      organizationId: input.actingParty.kind === "business" ? input.actingParty.id : null,
      accountType: input.accountType,
      providerName: input.providerName,
      providerAccountRef: input.providerAccountRef,
      maskedLast4: input.maskedLast4,
      institutionDisplayName: input.institutionDisplayName,
      cardExpiryMonth: input.cardExpiryMonth ?? null,
      cardExpiryYear: input.cardExpiryYear ?? null,
      cardBrand: input.cardBrand ?? null,
      bankAccountSubtype: input.bankAccountSubtype ?? null,
      addedByUserId: input.actingUserId,
    });
    await this.recordAccountAudit(account, "FINANCIAL_ACCOUNT_ADDED", input.actingUserId, null);
    return account;
  }

  async listAccountsForParty(actingUserId: string, party: PartyRef): Promise<FinancialAccountRecord[]> {
    await this.authorizeParty(actingUserId, party);
    return this.deps.financialAccounts.listForParty(
      party.kind === "personal" ? party.id : null,
      party.kind === "business" ? party.id : null,
    );
  }

  /** Called by the ACH/debit-card verification connector once the underlying provider/sandbox verification concludes — never invoked directly by a route handler. */
  async applyVerificationResult(financialAccountId: string, outcome: "verified" | "failed"): Promise<FinancialAccountRecord> {
    const account = await this.requireAccount(financialAccountId);
    if (account.status !== "pending_verification") {
      throw new ValidationError(`Only a pending-verification account can receive a verification result (current status "${account.status}").`);
    }
    const updated =
      outcome === "verified"
        ? await this.deps.financialAccounts.markVerified(account.id, new Date())
        : await this.deps.financialAccounts.markFailed(account.id);
    await this.recordAccountAudit(updated, outcome === "verified" ? "FINANCIAL_ACCOUNT_VERIFIED" : "FINANCIAL_ACCOUNT_VERIFICATION_FAILED", account.addedByUserId, null);
    return updated;
  }

  /**
   * Manual UAT remediation (#10 "Bank Account Removal"): previously callable with no in-use check at
   * all — an account could be silently disabled while it was still a relationship's active
   * funding/payout source, breaking that relationship's ability to process payments with no warning
   * to the user. Now blocks with a clear, specific `ValidationError` naming which relationship(s) are
   * still using it, rather than disabling first and letting the breakage surface later as a mysterious
   * payment failure.
   */
  async disableAccount(input: { financialAccountId: string; actingUserId: string; actingParty: PartyRef; reason: string }): Promise<FinancialAccountRecord> {
    await this.authorizeParty(input.actingUserId, input.actingParty);
    const account = await this.requireAccount(input.financialAccountId);
    this.requireAccountOwnedBy(account, input.actingParty);
    if (account.status === "disabled") return account;
    const activeAssignments = await this.deps.assignments.listActiveAssignmentsForAccount(account.id);
    if (activeAssignments.length > 0) {
      const usages = [...new Set(activeAssignments.map((a) => a.usage))].join(" and ");
      throw new ValidationError(
        `This account is currently in use as the ${usages} source for ${activeAssignments.length === 1 ? "an active connection" : `${activeAssignments.length} active connections`}. Replace it there first (Connection detail → Replace) before removing it here.`,
      );
    }
    const updated = await this.deps.financialAccounts.markDisabled(account.id, new Date());
    await this.recordAccountAudit(updated, "FINANCIAL_ACCOUNT_DISABLED", input.actingUserId, input.reason);
    return updated;
  }

  /**
   * Internal/trusted-server view — the full, unredacted assignment list (both slots, full bank
   * details) for a relationship the caller participates in. Reserved for server-side collaborators
   * that need the actual account (e.g. resolving `providerAccountRef` to authorize an ACH mandate —
   * see authorize-mandate's route handler) and that themselves apply any further role-specific
   * filtering they need. Never call this on behalf of rendering anything back to a browser — use
   * `getRelationshipAccountsForParticipant` for that (see its own doc comment for why).
   */
  async getRelationshipAccounts(relationshipId: string, actingUserId: string): Promise<RelationshipFinancialAccountAssignmentWithAccount[]> {
    await this.requireRelationship(relationshipId);
    await this.resolveActingParticipant(relationshipId, actingUserId);
    return this.deps.assignments.listForRelationship(relationshipId);
  }

  /**
   * Privacy remediation (connection P2P-EZ2R-V3MM): the ONLY method the connection-detail UI's
   * account read should ever call. Unlike `getRelationshipAccounts`, this never returns the
   * counterparty's bank name, last four, account type, status, or financial-account id — only whether
   * their slot is `ready`. Each participant sees full detail for exactly the one slot their own role
   * owns (see `usageForRole`), regardless of who happens to have selected the account.
   */
  async getRelationshipAccountsForParticipant(relationshipId: string, actingUserId: string): Promise<RelationshipAccountSlotView[]> {
    await this.requireRelationship(relationshipId);
    const participant = await this.resolveActingParticipant(relationshipId, actingUserId);
    const myUsage = usageForRole(participant.role);
    const assignments = await this.deps.assignments.listForRelationship(relationshipId);
    const usages: FinancialAccountUsage[] = ["funding", "payout"];
    return usages.map((usage) => {
      const active = assignments.find((a) => a.usage === usage && a.status === "active");
      const mine = usage === myUsage;
      return {
        usage,
        mine,
        assignmentId: active?.id ?? null,
        status: active?.status ?? null,
        ready: active?.financialAccount.status === "verified",
        account:
          mine && active
            ? {
                id: active.financialAccount.id,
                accountType: active.financialAccount.accountType,
                maskedLast4: active.financialAccount.maskedLast4,
                institutionDisplayName: active.financialAccount.institutionDisplayName,
                status: active.financialAccount.status,
              }
            : null,
      };
    });
  }

  /** Admin connector (Phase 37): read-only, masked support view — see AdminFinancialAccountAssignmentView's own doc comment for exactly what is/isn't exposed. Itself audited, matching RelationshipService.getRelationshipForAdmin's identical precedent. */
  async getRelationshipAccountsForAdmin(
    relationshipId: string,
    actingUserId: string,
    actingRole: PlatformRole,
  ): Promise<AdminFinancialAccountAssignmentView[]> {
    if (!isAdminRole(actingRole)) {
      throw new ForbiddenError("Administrative access is required.");
    }
    const assignments = await this.deps.assignments.listForRelationship(relationshipId);
    await this.recordAssignmentAudit(relationshipId, actingUserId, "ADMIN_RELATIONSHIP_FINANCIAL_ACCOUNTS_VIEWED", null);
    return assignments.map((a) => ({
      assignmentId: a.id,
      usage: a.usage,
      assignmentStatus: a.status,
      accountType: a.financialAccount.accountType,
      accountStatus: a.financialAccount.status,
      maskedLast4: a.financialAccount.maskedLast4,
      institutionDisplayName: a.financialAccount.institutionDisplayName,
      bankAccountSubtype: a.financialAccount.bankAccountSubtype,
      effectiveFrom: a.effectiveFrom,
      effectiveTo: a.effectiveTo,
    }));
  }

  async assignAccount(input: {
    relationshipId: string;
    actingUserId: string;
    financialAccountId: string;
    usage: FinancialAccountUsage;
  }): Promise<RelationshipFinancialAccountAssignmentRecord> {
    await this.requireRelationship(input.relationshipId);
    const participant = await this.resolveActingParticipant(input.relationshipId, input.actingUserId);
    this.requireUsageMatchesRole(participant, input.usage);
    const account = await this.requireAccount(input.financialAccountId);
    this.requireAccountBelongsToParticipant(account, participant);
    if (account.status !== "verified") {
      throw new ValidationError("Only a verified financial account may be assigned to a relationship.");
    }

    const existing = await this.deps.assignments.findActiveAssignment(input.relationshipId, input.usage);
    if (existing) {
      throw new ConflictError(`This relationship already has an active ${input.usage} account assigned. Use replaceAccount to change it.`);
    }

    // SPRINT_19_FraudRisk_SecurityHardening: same insert-then-recheck-on-conflict pattern as
    // replaceAccount below — two truly concurrent first-time assignAccount calls could both pass the
    // `existing` check above before either writes; the DB's partial unique index still guarantees
    // only one succeeds, this only turns the loser's raw constraint error into a clean domain one.
    let assignment;
    try {
      assignment = await this.deps.assignments.insertAssignment({
        relationshipId: input.relationshipId,
        relationshipParticipantId: participant.id,
        financialAccountId: account.id,
        usage: input.usage,
        selectedByUserId: input.actingUserId,
      });
    } catch (error) {
      const raced = await this.deps.assignments.findActiveAssignment(input.relationshipId, input.usage);
      if (raced) {
        throw new ConflictError(`This relationship already has an active ${input.usage} account assigned. Use replaceAccount to change it.`);
      }
      throw error;
    }
    await this.recordAssignmentAudit(input.relationshipId, input.actingUserId, "FINANCIAL_ACCOUNT_ASSIGNMENT_CREATED", {
      assignmentId: assignment.id,
      financialAccountId: account.id,
      usage: input.usage,
    });
    await this.deps.relationshipSync.syncFromFinancialAccounts(input.relationshipId);
    return assignment;
  }

  /** See this class's own doc comment for why counterparty approval is deliberately not required here. */
  async replaceAccount(input: {
    relationshipId: string;
    actingUserId: string;
    actingSessionId: string;
    financialAccountId: string;
    usage: FinancialAccountUsage;
  }): Promise<RelationshipFinancialAccountAssignmentRecord> {
    await this.requireRelationship(input.relationshipId);
    const participant = await this.resolveActingParticipant(input.relationshipId, input.actingUserId);
    this.requireUsageMatchesRole(participant, input.usage);
    const account = await this.requireAccount(input.financialAccountId);
    this.requireAccountBelongsToParticipant(account, participant);
    if (account.status !== "verified") {
      throw new ValidationError("Only a verified financial account may be assigned to a relationship.");
    }

    // SPRINT_19_FraudRisk_SecurityHardening: docs/SECURITY_MODEL.md threat #16 (payout redirection)
    // requires elevated MFA before a bank/payout-detail change — replacing which account a
    // relationship pays from/to is exactly that change. Checked after ownership/verification so a
    // stranger never learns anything about an account they don't own via a step-up prompt.
    const stepUpOk = await this.deps.mfa.requireStepUp({
      userId: input.actingUserId,
      sessionId: input.actingSessionId,
      action: "replace_financial_account",
    });
    if (!stepUpOk) {
      throw new StepUpRequiredError(
        "Step-up verification is required before replacing a funding or payout account. Please complete a fresh verification challenge and try again.",
      );
    }

    const existing = await this.deps.assignments.findActiveAssignment(input.relationshipId, input.usage);
    if (existing && existing.relationshipParticipantId !== participant.id) {
      throw new ForbiddenError("You may only replace the account assigned by your own participation in this relationship.");
    }
    if (existing && existing.financialAccountId === account.id) {
      return existing; // idempotent — replacing with the same account is a no-op
    }

    // SPRINT_19_FraudRisk_SecurityHardening: the DB has a real partial unique index — only one
    // *active* row may exist per (relationshipId, usage) at a time
    // (`relationship_financial_account_active_slot_unique`, src/db/schema/financialAccount.ts). This
    // previously inserted the new active row BEFORE marking the old one superseded, which would
    // violate that index on every ordinary (non-racing) replacement, not just a race — both rows
    // would briefly be "active" simultaneously. Generating the new row's id up front lets the old row
    // be superseded-by-it FIRST, so at insert time exactly zero active rows exist for this slot.
    let assignment;
    if (existing) {
      const newAssignmentId = randomUUID();
      await this.deps.assignments.markSuperseded(existing.id, newAssignmentId);
      try {
        assignment = await this.deps.assignments.insertAssignment({
          id: newAssignmentId,
          relationshipId: input.relationshipId,
          relationshipParticipantId: participant.id,
          financialAccountId: account.id,
          usage: input.usage,
          selectedByUserId: input.actingUserId,
        });
      } catch (error) {
        // The old row is already superseded either way — a losing concurrent replaceAccount call
        // collides with the WINNER's new active row here, not with the (already-superseded) old one.
        const raced = await this.deps.assignments.findActiveAssignment(input.relationshipId, input.usage);
        if (raced && raced.id !== existing.id) {
          throw new ConflictError(
            "This funding/payout account was just replaced by another concurrent request. Please refresh and try again.",
          );
        }
        throw error;
      }
    } else {
      // No prior active row for this slot — nothing to supersede, so a concurrent race here is a
      // genuine simultaneous first-time assignment, handled the same way assignAccount handles it.
      try {
        assignment = await this.deps.assignments.insertAssignment({
          relationshipId: input.relationshipId,
          relationshipParticipantId: participant.id,
          financialAccountId: account.id,
          usage: input.usage,
          selectedByUserId: input.actingUserId,
        });
      } catch (error) {
        const raced = await this.deps.assignments.findActiveAssignment(input.relationshipId, input.usage);
        if (raced) {
          throw new ConflictError(
            "This funding/payout account was just assigned by another concurrent request. Please refresh and try again.",
          );
        }
        throw error;
      }
    }
    await this.recordAssignmentAudit(input.relationshipId, input.actingUserId, "FINANCIAL_ACCOUNT_ASSIGNMENT_REPLACED", {
      assignmentId: assignment.id,
      previousAssignmentId: existing?.id ?? null,
      financialAccountId: account.id,
      usage: input.usage,
    });
    if (existing) {
      // SPRINT_19_FraudRisk_SecurityHardening §12: "frequent bank changes" is one of this sprint's
      // own named risk indicators, and docs/SECURITY_MODEL.md threat #16 (payout redirection) is
      // exactly "an attacker changes a creditor's connected bank account." Recorded on every actual
      // replacement (not the idempotent same-account no-op above) — never blocks; a real windowed
      // frequency count (vs. this per-event record) is additive follow-up, not built here, per this
      // sprint's own "do not invent financial policy as fact." Never fails the replacement itself.
      try {
        await this.deps.riskEvents.recordSignal({
          userId: input.actingUserId,
          signalType: "frequent_bank_connection_change",
          severity: "low",
          outcome: "flagged",
          relatedResourceType: "relationship_financial_account_assignment",
          relatedResourceId: assignment.id,
          detail: { relationshipId: input.relationshipId, usage: input.usage },
        });
      } catch (error) {
        logger.error("risk_signal_record_failed", {
          signalType: "frequent_bank_connection_change",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.deps.relationshipSync.syncFromFinancialAccounts(input.relationshipId);

    if (existing && participant.representedByUserId) {
      const participants = await this.deps.participants.listForRelationship(input.relationshipId);
      const counterparty = participants.find((p) => p.id !== participant.id && p.representedByUserId);
      if (counterparty?.representedByUserId) {
        await this.deps.notifications.notify({
          recipientUserId: counterparty.representedByUserId,
          notificationType: input.usage === "funding" ? "relationship_funding_account_replaced" : "relationship_payout_account_replaced",
          relatedAgreementId: null,
          payload: { relationshipId: input.relationshipId, usage: input.usage },
          dedupeKey: `relationship_account_replaced:${assignment.id}`,
        });
      }
    }
    return assignment;
  }

  /**
   * REQUIRED OWNERSHIP MODEL (connection P2P-EZ2R-V3MM remediation): without this, a participant could
   * self-assign their OWN account into the OTHER usage slot (e.g. a debtor assigning their own account
   * as "payout") — `requireAccountBelongsToParticipant` alone only checks account ownership, never
   * which slot that participant's role is entitled to occupy. Left unchecked, that would let a
   * relationship's payout destination resolve to the debtor's own account instead of the creditor's
   * (see authorize-mandate's route handler, which trusts the funding slot's account to be the debtor's
   * once this invariant holds) — a payment-routing defect, not merely a display one.
   */
  private requireUsageMatchesRole(participant: RelationshipParticipantRecord, usage: FinancialAccountUsage): void {
    const requiredRole: PartyRole = usage === "funding" ? "debtor" : "creditor";
    if (participant.role !== requiredRole) {
      throw new ForbiddenError(`Only the ${requiredRole} may manage the ${usage} account for this relationship.`);
    }
  }

  private requireAccountBelongsToParticipant(account: FinancialAccountRecord, participant: RelationshipParticipantRecord): void {
    const sameParty =
      (account.individualProfileId !== null && account.individualProfileId === participant.individualProfileId) ||
      (account.organizationId !== null && account.organizationId === participant.organizationId);
    if (!sameParty) {
      throw new ForbiddenError("This financial account does not belong to your participation in this relationship.");
    }
  }

  private requireAccountOwnedBy(account: FinancialAccountRecord, party: PartyRef): void {
    const sameParty =
      (party.kind === "personal" && account.individualProfileId === party.id) ||
      (party.kind === "business" && account.organizationId === party.id);
    if (!sameParty) {
      throw new ForbiddenError("This financial account does not belong to the specified party.");
    }
  }

  private async resolveActingParticipant(relationshipId: string, actingUserId: string): Promise<RelationshipParticipantRecord> {
    const participants = await this.deps.participants.listForRelationship(relationshipId);
    for (const participant of participants) {
      if (participant.individualProfileId) {
        const ownerUserId = await this.deps.profileOwners.getOwnerUserId("personal", participant.individualProfileId);
        if (ownerUserId === actingUserId) return participant;
      } else if (participant.organizationId) {
        const ownerUserId = await this.deps.profileOwners.getOwnerUserId("business", participant.organizationId);
        if (ownerUserId === actingUserId) return participant;
        const isStaff = await this.deps.staffService
          .requireActiveStaff(participant.organizationId, actingUserId)
          .then(() => true)
          .catch(() => false);
        if (isStaff) return participant;
      }
    }
    throw new ForbiddenError("You are not a participant in this relationship.");
  }

  private async requireRelationship(id: string): Promise<void> {
    const relationship = await this.deps.relationships.findById(id);
    if (!relationship) throw new ValidationError("Relationship not found.");
    if (["closed", "cancelled"].includes(relationship.status)) {
      throw new ValidationError(`This relationship is ${relationship.status} and no longer accepts financial account changes.`);
    }
  }

  private async requireAccount(id: string): Promise<FinancialAccountRecord> {
    const account = await this.deps.financialAccounts.findById(id);
    if (!account) throw new ValidationError("Financial account not found.");
    return account;
  }

  /**
   * SPRINT_19_FraudRisk_SecurityHardening: public wrapper so BankConnectionService (a collaborator,
   * not a subclass — it holds this service via composition to call `addAccount`) can authorize the
   * acting party BEFORE requiring MFA step-up, matching SignatureService.sign's established
   * "authorize, then step-up" ordering — a stranger to a profile should never even reach a step-up
   * prompt for it.
   */
  async requireOwnedParty(actingUserId: string, party: PartyRef): Promise<void> {
    return this.authorizeParty(actingUserId, party);
  }

  private async authorizeParty(actingUserId: string, party: PartyRef): Promise<void> {
    if (party.kind === "personal") {
      const ownerUserId = await this.deps.profileOwners.getOwnerUserId("personal", party.id);
      if (ownerUserId !== actingUserId) {
        throw new ForbiddenError("You do not have access to this profile.");
      }
      return;
    }
    const ownerUserId = await this.deps.profileOwners.getOwnerUserId("business", party.id);
    if (ownerUserId === actingUserId) return;
    await this.deps.staffService.requireCapability(party.id, actingUserId, FINANCIAL_ACCOUNT_CAPABILITY);
  }

  private async recordAccountAudit(account: FinancialAccountRecord, action: string, actorUserId: string, reason: string | null): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "agreement_party",
      profileKind: account.individualProfileId ? "personal" : "business",
      profileId: account.individualProfileId ?? account.organizationId,
      agreementId: null,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: account.status,
      reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "financial_account",
      targetResourceId: account.id,
    });
  }

  private async recordAssignmentAudit(relationshipId: string, actorUserId: string, action: string, newValue: unknown): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "agreement_party",
      profileKind: null,
      profileId: null,
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
      relatedCaseId: relationshipId,
      targetResourceType: "relationship",
      targetResourceId: relationshipId,
    });
  }
}
