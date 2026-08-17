/**
 * PRSprint 15 (docs/prsprints/PRSPRINT_15_PRODUCTION_SMS.md), requirement #7: canonical E.164 phone
 * normalization/validation. Deliberately not a full libphonenumber-style library (no new dependency,
 * matching this codebase's established zero-external-dependency style for cross-cutting concerns) —
 * this handles the two shapes this app actually needs to accept: an already-E.164 value, and a bare
 * 10-digit US number (the overwhelmingly likely input shape for a US-only transactional product, per
 * PRSprint 15's own "Paid2You will send transactional SMS in the United States" framing). Anything
 * else is rejected rather than guessed at — a wrong guess here means a real SMS to a real stranger.
 */

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * Normalizes a user-supplied phone number into E.164 (`+<countrycode><number>`, no spaces/punctuation).
 * Returns `null` if the input can't be confidently normalized — callers must treat that as "invalid,"
 * never fall back to sending to the raw, unnormalized value.
 */
export function normalizeE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Already E.164 (or something we can validate as such once formatting punctuation is stripped from
  // a "+"-prefixed value — e.g. "+1 (555) 123-4567").
  if (trimmed.startsWith("+")) {
    const stripped = `+${trimmed.slice(1).replace(/[\s().-]/g, "")}`;
    return E164_PATTERN.test(stripped) ? stripped : null;
  }

  // Bare digits with common US formatting punctuation — assume US/Canada (+1) only when the digit
  // count matches exactly; never guess a country code for any other length.
  const digitsOnly = trimmed.replace(/[\s().-]/g, "");
  if (/^\d{10}$/.test(digitsOnly)) {
    return `+1${digitsOnly}`;
  }
  if (/^1\d{10}$/.test(digitsOnly)) {
    return `+${digitsOnly}`;
  }

  return null;
}

export function isValidE164(value: string): boolean {
  return E164_PATTERN.test(value);
}

/** Masks all but the last two digits — for logs/admin display, never the raw destination (requirement #27/#37). */
export function maskPhone(e164: string): string {
  if (e164.length <= 4) return "***";
  return `${e164.slice(0, 2)}${"*".repeat(Math.max(0, e164.length - 4))}${e164.slice(-2)}`;
}
