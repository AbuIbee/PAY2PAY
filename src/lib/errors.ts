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
  constructor(message: string, cause?: unknown) {
    super(message, {
      statusCode: 400,
      code: "VALIDATION_ERROR",
      isOperational: true,
      cause,
    });
    this.name = "ValidationError";
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
