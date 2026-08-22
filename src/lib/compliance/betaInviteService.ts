import "server-only";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { PlatformRole } from "@/lib/auth/authService";
import { isAdminRole } from "@/lib/admin/capabilities";

export interface BetaInviteCodeRecord {
  id: string;
  code: string;
  createdByUserId: string;
  createdAt: Date;
  note: string | null;
  usedByUserId: string | null;
  usedAt: Date | null;
}

/** Real implementation: DrizzleBetaInviteRepository. */
export interface BetaInviteRepository {
  insert(input: { code: string; createdByUserId: string; note: string | null }): Promise<BetaInviteCodeRecord>;
  /** Read-only — exists and not yet used. Never mutates; see BetaInviteService's own doc comment for why this and `claimCode` are two separate steps. */
  peekCode(code: string): Promise<BetaInviteCodeRecord | null>;
  /**
   * Atomic — `WHERE code = $1 AND used_by_user_id IS NULL`, in the same statement as the write. Two
   * people racing to redeem the same code must never both succeed. Returns `null`, never throws, if
   * the code doesn't exist or was already used.
   */
  claimCode(code: string, usedByUserId: string): Promise<BetaInviteCodeRecord | null>;
  listAll(): Promise<BetaInviteCodeRecord[]>;
}

/**
 * PRSprint 33 (docs/prsprints/PRSPRINT_33_FINAL_PRODUCTION_LAUNCH_CONTROLS_CLOSED_BETA.md): master-
 * spec items 153/199, "financial launch should be phased... use a small controlled cohort." Only
 * consulted from the signup *route* (src/app/api/auth/signup/route.ts), never from
 * `AuthService.signup` itself — `authService.ts` is a PRSprint 11A protected baseline ("account
 * creation" is explicitly protected behavior; see docs/prsprints/PRSPRINT_CONTROL.md's Protected
 * Baselines section), so this gate lives entirely outside it: the route pre-checks a code *before*
 * ever calling `authService.signup`, exactly like that same route's existing rate-limit check already
 * does — an invalid code means `authService.signup` is never reached, and its own tested behavior is
 * completely unaffected by this class existing.
 *
 * Two-phase by necessity, not choice: `claimCode`'s `used_by_user_id` column has a foreign-key
 * constraint on `user_account`, and the whole point of checking *before* signup is that the new
 * account doesn't exist yet at that point — there is no user id to claim with until after
 * `authService.signup` has actually run. So the route calls `checkCodeIsRedeemable` first (a read-only
 * peek — fails fast with a clear error before ever creating an account for an invalid code), then
 * `authService.signup`, then `consumeCode` (the atomic claim, now that a real user id exists).
 *
 * Known limitation, documented rather than silently accepted: there is a narrow race window between
 * the pre-check and the atomic claim where two people could both pass the pre-check for the same code
 * and both successfully sign up, with only one of them actually consuming the code (the other's
 * `consumeCode` call fails, but by then their account already exists). This is judged an acceptable
 * trade-off for a soft cohort-size guardrail — not a security or financial boundary — rather than
 * building account-creation rollback (which does not exist anywhere in this codebase) to close it.
 */
export class BetaInviteService {
  constructor(private readonly deps: { invites: BetaInviteRepository }) {}

  async generateCode(input: { code: string; createdByUserId: string; note: string | null; actingRole: PlatformRole }): Promise<BetaInviteCodeRecord> {
    if (!isAdminRole(input.actingRole)) {
      throw new ForbiddenError("Administrative access is required.");
    }
    if (!input.code.trim()) {
      throw new ValidationError("A code value is required.");
    }
    return this.deps.invites.insert({ code: input.code, createdByUserId: input.createdByUserId, note: input.note });
  }

  async listCodes(actingRole: PlatformRole): Promise<BetaInviteCodeRecord[]> {
    if (!isAdminRole(actingRole)) {
      throw new ForbiddenError("Administrative access is required.");
    }
    return this.deps.invites.listAll();
  }

  /** Pre-signup fail-fast check. Never leaks *why* a code is rejected (unknown vs. already-used look identical) — avoids a code-enumeration side channel. */
  async checkCodeIsRedeemable(code: string): Promise<void> {
    const trimmed = code.trim();
    if (!trimmed || !(await this.deps.invites.peekCode(trimmed))) {
      throw new ValidationError("This invite code is invalid or has already been used.");
    }
  }

  /** Post-signup atomic consumption — see this class's own doc comment for the two-phase rationale and its known race-window limitation. */
  async consumeCode(code: string, userId: string): Promise<BetaInviteCodeRecord | null> {
    return this.deps.invites.claimCode(code.trim(), userId);
  }
}
