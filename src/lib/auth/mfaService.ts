import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ValidationError } from "@/lib/errors";
import type { SmsSender } from "@/lib/notify/smsSender";
import { generateNumericCode, hashNumericCode } from "./token";
import { buildTotpUri, generateTotpSecret, verifyTotp } from "./totp";

export type MfaMethod = "totp" | "sms";

export interface MfaCredentialRecord {
  id: string;
  userId: string;
  method: MfaMethod;
  secretRef: string | null;
  phoneRef: string | null;
  verifiedAt: Date | null;
  disabledAt: Date | null;
}

/**
 * Sprint 2 (docs/sprints/SPRINT_02_Authentication.md) MFA/step-up
 * infrastructure. This sprint builds the primitive only — Sprints 4, 6, and
 * 15 call `requireStepUp` for their own sensitive actions rather than
 * re-implementing MFA (see those sprints' updated text).
 *
 * Passkey (WebAuthn) enrollment is deliberately NOT implemented here — see
 * docs/AUTHENTICATION.md for the reasoning (rolling custom WebAuthn
 * attestation/assertion verification without a vetted library is a
 * meaningfully different risk profile than the TOTP algorithm, which is
 * small, published, and verified against the RFC 6238 test vector in
 * totp.test.ts). "passkey" remains reserved in the mfa_method enum so
 * enrolling one later needs no migration.
 */
export interface MfaCredentialRepository {
  insert(input: {
    userId: string;
    method: MfaMethod;
    secretRef: string | null;
    phoneRef: string | null;
  }): Promise<MfaCredentialRecord>;
  findLatestByUserAndMethod(userId: string, method: MfaMethod): Promise<MfaCredentialRecord | null>;
  findVerifiedByUserId(userId: string): Promise<MfaCredentialRecord[]>;
  markVerified(id: string): Promise<void>;
  disable(id: string): Promise<void>;
}

export type MfaChallengePurpose = "enrollment" | "step_up";

export interface MfaChallengeRecord {
  id: string;
  userId: string;
  method: MfaMethod;
  codeHash: string | null;
  purpose: MfaChallengePurpose;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
}

export interface MfaChallengeRepository {
  insert(input: {
    userId: string;
    method: MfaMethod;
    codeHash: string | null;
    purpose: MfaChallengePurpose;
    expiresAt: Date;
  }): Promise<MfaChallengeRecord>;
  findLatestPending(
    userId: string,
    method: MfaMethod,
    purpose: MfaChallengePurpose,
  ): Promise<MfaChallengeRecord | null>;
  incrementAttempts(id: string): Promise<void>;
  consume(id: string): Promise<void>;
}

export interface StepUpVerificationRepository {
  insert(input: { sessionId: string; expiresAt: Date }): Promise<void>;
  /** Most recent unexpired step-up for this session, or null if none / expired. */
  findActiveForSession(sessionId: string, now: Date): Promise<{ expiresAt: Date } | null>;
}

export interface MfaServiceOptions {
  /** How long a completed step-up challenge stays valid for. Default 15 minutes. */
  stepUpFreshnessMs?: number;
  /** How long an SMS code stays valid for. Default 5 minutes. */
  smsChallengeTtlMs?: number;
  maxSmsAttempts?: number;
}

const DEFAULT_STEP_UP_FRESHNESS_MS = 15 * 60 * 1000;
const DEFAULT_SMS_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SMS_ATTEMPTS = 5;

export class MfaService {
  constructor(
    private readonly credentials: MfaCredentialRepository,
    private readonly challenges: MfaChallengeRepository,
    private readonly stepUps: StepUpVerificationRepository,
    private readonly audit: AuditService,
    private readonly smsSender: SmsSender,
    private readonly options: MfaServiceOptions = {},
  ) {}

  async hasVerifiedMethod(userId: string): Promise<boolean> {
    const verified = await this.credentials.findVerifiedByUserId(userId);
    return verified.length > 0;
  }

  /**
   * Sprint 18B: the enrollment UI and the step-up challenge UI both need to
   * know, before rendering anything, which verified methods (if any) exist
   * for this user — otherwise a step-up challenge could be shown to a user
   * with no enrolled method at all, who can never complete it. Read-only,
   * no new state.
   */
  async listEnrolledMethods(userId: string): Promise<MfaMethod[]> {
    const verified = await this.credentials.findVerifiedByUserId(userId);
    return [...new Set(verified.map((credential) => credential.method))];
  }

  async beginTotpEnrollment(
    userId: string,
    accountLabel: string,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const secret = generateTotpSecret();
    await this.credentials.insert({ userId, method: "totp", secretRef: secret, phoneRef: null });
    return { secret, otpauthUri: buildTotpUri(secret, accountLabel) };
  }

  async confirmTotpEnrollment(userId: string, code: string): Promise<void> {
    const pending = await this.credentials.findLatestByUserAndMethod(userId, "totp");
    if (!pending || pending.verifiedAt || !pending.secretRef) {
      throw new ValidationError("No pending authenticator-app enrollment found.");
    }
    if (!verifyTotp(pending.secretRef, code)) {
      throw new ValidationError("Incorrect code. Please try again.");
    }
    await this.credentials.markVerified(pending.id);
    await this.recordAudit(userId, "mfa_totp_enrolled");
  }

  async beginSmsEnrollment(userId: string, phoneNumber: string): Promise<void> {
    await this.credentials.insert({ userId, method: "sms", secretRef: null, phoneRef: phoneNumber });
    await this.dispatchSmsChallenge(userId, phoneNumber, "enrollment");
  }

  async confirmSmsEnrollment(userId: string, code: string): Promise<void> {
    const pending = await this.credentials.findLatestByUserAndMethod(userId, "sms");
    if (!pending || pending.verifiedAt) {
      throw new ValidationError("No pending SMS enrollment found.");
    }
    await this.consumeSmsCode(userId, code, "enrollment");
    await this.credentials.markVerified(pending.id);
    await this.recordAudit(userId, "mfa_sms_enrolled");
  }

  async disableMethod(userId: string, credentialId: string): Promise<void> {
    await this.credentials.disable(credentialId);
    await this.recordAudit(userId, "mfa_method_disabled");
  }

  /**
   * Sends an SMS code for a step-up challenge. Not needed before a TOTP
   * step-up (the user reads the code from their already-enrolled
   * authenticator app), only before an SMS one.
   */
  async initiateStepUp(userId: string, method: MfaMethod): Promise<void> {
    if (method !== "sms") return;
    const verified = await this.credentials.findVerifiedByUserId(userId);
    const credential = verified.find((c) => c.method === "sms");
    if (!credential?.phoneRef) {
      throw new ValidationError("SMS is not an enrolled method for this account.");
    }
    await this.dispatchSmsChallenge(userId, credential.phoneRef, "step_up");
  }

  /** Verifies a step-up code and, if correct, grants a fresh step-up window for this session. */
  async completeStepUp(input: {
    userId: string;
    sessionId: string;
    method: MfaMethod;
    code: string;
    action: string;
  }): Promise<boolean> {
    const verified = await this.credentials.findVerifiedByUserId(input.userId);
    const credential = verified.find((c) => c.method === input.method);
    if (!credential) {
      await this.recordAudit(input.userId, "step_up_check_failed", input.action);
      return false;
    }

    let ok = false;
    if (input.method === "totp") {
      ok = credential.secretRef ? verifyTotp(credential.secretRef, input.code) : false;
    } else {
      try {
        await this.consumeSmsCode(input.userId, input.code, "step_up");
        ok = true;
      } catch {
        ok = false;
      }
    }

    if (ok) {
      const expiresAt = new Date(Date.now() + (this.options.stepUpFreshnessMs ?? DEFAULT_STEP_UP_FRESHNESS_MS));
      await this.stepUps.insert({ sessionId: input.sessionId, expiresAt });
    }
    await this.recordAudit(input.userId, ok ? "step_up_check_passed" : "step_up_check_failed", input.action);
    return ok;
  }

  /**
   * The primitive other sprints call before a sensitive action
   * (docs/sprints/SPRINT_02_Authentication.md). Returns false — never
   * throws, never silently grants access — if the user has no verified MFA
   * method enrolled (caller should show an enrollment prompt) or if there is
   * no fresh step-up for this session (caller should prompt for a
   * challenge). There is no recovery/bypass path: this method has no way to
   * return true other than a real, recent, successful completeStepUp call
   * for this exact session.
   */
  async requireStepUp(input: { userId: string; sessionId: string; action: string }): Promise<boolean> {
    const hasAny = await this.hasVerifiedMethod(input.userId);
    if (!hasAny) return false;
    const active = await this.stepUps.findActiveForSession(input.sessionId, new Date());
    return active !== null;
  }

  private async dispatchSmsChallenge(
    userId: string,
    phoneNumber: string,
    purpose: MfaChallengePurpose,
  ): Promise<void> {
    const code = generateNumericCode();
    const expiresAt = new Date(Date.now() + (this.options.smsChallengeTtlMs ?? DEFAULT_SMS_CHALLENGE_TTL_MS));
    await this.challenges.insert({ userId, method: "sms", codeHash: hashNumericCode(code), purpose, expiresAt });
    await this.smsSender.send({
      to: phoneNumber,
      body: `Your PAY2PAY verification code is ${code}. It expires in 5 minutes.`,
    });
  }

  private async consumeSmsCode(userId: string, code: string, purpose: MfaChallengePurpose): Promise<void> {
    const challenge = await this.challenges.findLatestPending(userId, "sms", purpose);
    if (!challenge || challenge.consumedAt || challenge.expiresAt.getTime() <= Date.now()) {
      throw new ValidationError("This code has expired. Please request a new one.");
    }
    if (challenge.attempts >= (this.options.maxSmsAttempts ?? DEFAULT_MAX_SMS_ATTEMPTS)) {
      throw new ValidationError("Too many incorrect attempts. Please request a new code.");
    }
    if (hashNumericCode(code) !== challenge.codeHash) {
      await this.challenges.incrementAttempts(challenge.id);
      throw new ValidationError("Incorrect code. Please try again.");
    }
    await this.challenges.consume(challenge.id);
  }

  private async recordAudit(userId: string, action: string, reason: string | null = null): Promise<void> {
    await this.audit.record({
      actorUserId: userId,
      actorRole: "personal_user",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: null,
      reason,
      authStrength: "mfa",
      relatedDocumentId: null,
      relatedCaseId: null,
    });
  }
}
