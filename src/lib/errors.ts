/**
 * Centralized error hierarchy. API routes and services should throw one of
 * these (or a subclass) rather than a bare Error, so error handling at the
 * boundary (see toSafeErrorResponse) can make a deliberate choice about what
 * is safe to expose to a client versus what must stay server-side only.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** Operational errors are expected/handled conditions (e.g. bad input).
   *  Non-operational errors indicate a bug or misconfiguration. */
  readonly isOperational: boolean;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      code?: string;
      isOperational?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? "INTERNAL_ERROR";
    this.isOperational = options.isOperational ?? true;
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      statusCode: 500,
      code: "CONFIGURATION_ERROR",
      isOperational: false,
      cause,
    });
    this.name = "ConfigurationError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, cause?: unknown, code = "VALIDATION_ERROR") {
    super(message, {
      statusCode: 400,
      code,
      isOperational: true,
      cause,
    });
    this.name = "ValidationError";
  }
}

/**
 * The agreement's proposed first-payment date has already passed while it is still unsigned. Still
 * an instanceof ValidationError (existing callers/tests that check for that keep working), but with
 * its own `code` so a client can reliably offer a schedule-revision action and retry, instead of
 * treating this as an ordinary, non-actionable validation failure — mirrors StepUpRequiredError's
 * identical "distinct code for a distinct guided recovery flow" precedent.
 */
export class ScheduleRevisionRequiredError extends ValidationError {
  constructor(message = "This agreement's proposed first payment date has already passed and must be revised before signing.") {
    super(message, undefined, "SCHEDULE_REVISION_REQUIRED");
    this.name = "ScheduleRevisionRequiredError";
  }
}

/**
 * PAID2YOU — B0-D PHASE 3C (creditor payout eligibility): thrown by `PayoutService.confirmPayout`
 * when the payment's recipient (the creditor who would receive this payout) has not reached this
 * codebase's FULL identity-verification tier (`VerificationService.isFullyVerified`) — missing,
 * pending, rejected, or a verification belonging to a different profile than the actual creditor all
 * fail this check the same way, since `isFullyVerified` is always looked up against the payment's own
 * authoritative `recipientProfileKind`/`recipientProfileId`, never caller-supplied identifiers.
 * Deliberately distinct from `ProviderNotAvailableError` (whether ANY live payout-provider integration
 * exists at all) — internal FULL verification is not Adyen KYC approval, and satisfying one gate never
 * substitutes for the other; both are independently enforced.
 */
export class CreditorNotVerifiedError extends ValidationError {
  constructor(message = "This payout cannot be confirmed until the creditor has completed full identity verification.") {
    super(message, undefined, "CREDITOR_NOT_VERIFIED");
    this.name = "CreditorNotVerifiedError";
  }
}

/** Missing/invalid/expired/revoked session, or failed login credentials. */
export class AuthenticationError extends AppError {
  constructor(message = "Authentication required.") {
    super(message, {
      statusCode: 401,
      code: "UNAUTHENTICATED",
      isOperational: true,
    });
    this.name = "AuthenticationError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, {
      statusCode: 409,
      code: "CONFLICT",
      isOperational: true,
    });
    this.name = "ConflictError";
  }
}

/**
 * A correctly-authenticated account that is suspended/closed. Deliberately
 * distinct from AuthenticationError: this is only ever thrown *after*
 * password verification succeeds, so revealing "this account is disabled"
 * here cannot be used for account-enumeration (an attacker would already
 * need the correct password to reach this branch).
 */
export class AccountDisabledError extends AppError {
  constructor(message = "This account has been disabled.") {
    super(message, {
      statusCode: 403,
      code: "ACCOUNT_DISABLED",
      isOperational: true,
    });
    this.name = "AccountDisabledError";
  }
}

/**
 * Correctly authenticated, but not authorized for the specific resource
 * requested (Sprint 3: selecting another user's business profile). Distinct
 * from AuthenticationError (401, "who are you") — this is "we know who you
 * are, but you can't do this."
 */
export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this resource.", code = "FORBIDDEN") {
    super(message, {
      statusCode: 403,
      code,
      isOperational: true,
    });
    this.name = "ForbiddenError";
  }
}

/**
 * A fresh MFA step-up (see MfaService.requireStepUp) is needed before this
 * action can proceed. Still an instanceof ForbiddenError (existing tests/
 * callers that check for that keep working), but with its own `code` so a
 * client can reliably show a step-up challenge and retry the original
 * action, instead of treating this the same as any other authorization
 * failure (Sprint 18B: "action -> backend says step-up required -> UI
 * challenge -> success -> safely retry original action").
 */
export class StepUpRequiredError extends ForbiddenError {
  constructor(message = "Step-up verification is required to continue.") {
    super(message, "STEP_UP_REQUIRED");
    this.name = "StepUpRequiredError";
  }
}

/**
 * Agreement Lifecycle V2: the invited counterparty must review, accept, and sign before the
 * originator (whoever created the draft) is allowed to sign — "the agreement is NOT Active yet"
 * after only the counterparty has signed, and the originator's own attempt to sign first must be
 * blocked with a specific, actionable message rather than silently allowed out of order. Still an
 * instanceof ForbiddenError (this is an authorization/ordering rule, not a data-validation one), with
 * its own code so the client can show "waiting on the other party" rather than a generic error.
 */
export class CounterpartyMustSignFirstError extends ForbiddenError {
  constructor(message = "The other party must review and sign first. You'll be notified as soon as they do.") {
    super(message, "COUNTERPARTY_MUST_SIGN_FIRST");
    this.name = "CounterpartyMustSignFirstError";
  }
}

/**
 * Production defect remediation (agreement participation requires a usable name): a personal party
 * attempted to acknowledge, accept, or sign an agreement while their own personal_profile has no
 * first_name/last_name on file. Still an instanceof ForbiddenError (an authorization-shaped rule, not
 * a data-validation one — the request itself is well-formed), with its own code so the client can
 * reliably show the "Complete your profile" CTA/returnTo flow instead of a generic error, mirroring
 * StepUpRequiredError's identical "distinct code for a distinct guided recovery flow" precedent. Never
 * thrown for a business party — see AgreementPartyNameReader's own doc comment.
 */
export class ProfileIncompleteError extends ForbiddenError {
  constructor(message = "Complete your profile before reviewing and signing this agreement.") {
    super(message, "PROFILE_INCOMPLETE");
    this.name = "ProfileIncompleteError";
  }
}

export class RateLimitedError extends AppError {
  constructor(message = "Too many requests. Please try again later.") {
    super(message, {
      statusCode: 429,
      code: "RATE_LIMITED",
      isOperational: true,
    });
    this.name = "RateLimitedError";
  }
}

/**
 * PRSprint 28 (docs/prsprints/PRSPRINT_28_ERROR_HANDLING_OBSERVABILITY_HEALTH_MONITORING.md):
 * "Do not turn all errors into generic 500s if a more accurate safe status is appropriate."
 * Distinguishes a downstream dependency (database, financial provider, email/SMS sender) being
 * unreachable/failing from an actual internal bug — 503, not 500, and a message that tells the caller
 * this is transient and worth retrying rather than a defect in their request. Never constructed with
 * provider-internal detail in its message (callers pass a safe, generic description; the real
 * exception is logged separately by the caller before throwing this).
 */
export class DependencyError extends AppError {
  constructor(message = "A required service is temporarily unavailable. Please try again shortly.") {
    super(message, {
      statusCode: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      isOperational: true,
    });
    this.name = "DependencyError";
  }
}

/**
 * PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION: thrown by the provider-availability guard
 * (src/lib/providers/providerCapabilities.ts's assertProviderAvailableForRuntime, invoked by
 * getPaymentProvider()/getKycProvider()/getCardIssuingProvider()) whenever no live, production-tagged
 * provider is registered for the requested capability. Deliberately distinct from ConfigurationError
 * (which means "this is a bug in how the app is wired") — this is an *expected*, operator-visible
 * state ("no live financial/KYC/card provider has been approved yet") that must stop the request
 * before any provider call, financial mutation, ledger mutation, or lifecycle transition — never a
 * silent substitution of sandbox/mock behavior. 503, not 500: this is the same "not a bug, a
 * temporarily/structurally unavailable dependency" shape DependencyError already uses, with its own
 * code so a client can reliably show "not yet available" instead of a generic error.
 */
export class ProviderNotAvailableError extends AppError {
  constructor(message = "This feature is not available yet. No live provider has been approved and configured.") {
    super(message, {
      statusCode: 503,
      code: "PROVIDER_NOT_AVAILABLE",
      isOperational: true,
    });
    this.name = "ProviderNotAvailableError";
  }
}

/**
 * PAID2YOU — B0-D ADYEN PHASE 1A: thrown by a `PaymentProvider` implementation for a specific
 * interface method it structurally cannot support against the real provider's actual API (e.g.
 * `AdyenPaymentProvider.retrievePayment` — Adyen's Checkout API has no GET-by-reference endpoint at
 * all). Deliberately distinct from `ProviderNotAvailableError` (no provider selected) and
 * `ConfigurationError` (a real wiring bug) — this is "the selected, correctly-configured provider is
 * live and working, but this one capability does not exist for it." Callers that have a safe
 * fallback (e.g. `ReconciliationService`, which can skip a provider-driven check it cannot perform)
 * should catch this specifically rather than treating it as a generic failure/data exception.
 */
export class ProviderCapabilityUnsupportedError extends AppError {
  constructor(message: string) {
    super(message, {
      statusCode: 501,
      code: "PROVIDER_CAPABILITY_UNSUPPORTED",
      isOperational: true,
    });
    this.name = "ProviderCapabilityUnsupportedError";
  }
}

export interface SafeErrorResponse {
  message: string;
  code: string;
  statusCode: number;
}

/**
 * Maps any thrown value to a response shape safe to return to a client.
 * Non-AppErrors (unexpected bugs, driver errors, etc.) are deliberately
 * flattened to a generic message so internal details never leak — the real
 * error should still be logged server-side by the caller before this is used.
 */
export function toSafeErrorResponse(error: unknown): SafeErrorResponse {
  if (error instanceof AppError) {
    return { message: error.message, code: error.code, statusCode: error.statusCode };
  }
  return {
    message: "An unexpected error occurred.",
    code: "INTERNAL_ERROR",
    statusCode: 500,
  };
}

/**
 * PRSprint 28: "Users should receive a stable user-facing error identifier/correlation ID where
 * useful so support can locate the corresponding operational event." Only meaningful for a genuinely
 * unexpected failure (5xx) — an ordinary validation/auth/rate-limit rejection (4xx) doesn't need one,
 * the message alone is actionable. `withErrorHandling` logs the identical id server-side alongside the
 * full error, so support can grep for it directly.
 */
export function isServerFault(statusCode: number): boolean {
  return statusCode >= 500;
}
