/**
 * PRSprint 05 (docs/prsprints/PRSPRINT_05_DISTRIBUTED_RATE_LIMITING_ABUSE_CONTROLS.md): a
 * CAPTCHA/human-challenge extension point. This codebase has no CAPTCHA provider today (PRSprint 04
 * confirmed zero external providers beyond Supabase) and no environment variable for one — this is
 * a HOOK, not a live integration, matching how `getPaymentProvider()`/`getKycProvider()` are
 * structured: a stable interface a future pass can wire a real provider (e.g. hCaptcha, Turnstile)
 * into, without any call site needing to change. `NoopChallengeProvider` is the only implementation
 * today and always passes, so wiring this into a route today changes nothing observable — it exists
 * so the extension point is architecturally ready before it's needed, not so it can be silently
 * mistaken for a working challenge right now.
 */
export interface ChallengeVerificationRequest {
  /** The client-submitted challenge token, if any (e.g. an hCaptcha/Turnstile response token). Null when no challenge was presented — always the case today, since no provider issues one. */
  token: string | null;
  /** A short label identifying which flow is asking (e.g. "login", "signup") — real providers use this for per-action risk scoring; unused by the no-op. */
  action: string;
  ipAddress: string;
}

export interface ChallengeVerificationResult {
  passed: boolean;
  reason?: string;
}

export interface ChallengeProvider {
  verify(request: ChallengeVerificationRequest): Promise<ChallengeVerificationResult>;
}

/** Always passes. The only implementation wired up today — see this file's module doc comment. */
export class NoopChallengeProvider implements ChallengeProvider {
  async verify(_request: ChallengeVerificationRequest): Promise<ChallengeVerificationResult> {
    return { passed: true };
  }
}
