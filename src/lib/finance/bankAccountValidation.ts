/**
 * Phase 6A (docs/prsprints/PHASE_6A_PREPRODUCTION_FINANCIAL_UX_COMPLETION.md): shared routing/account
 * number format validation, used both client-side (`BankConnectionForm`, as UX assistance) and
 * server-side (`bankConnectionService.ts`, as the actual gate). Deliberately has no "server-only"
 * import so it can run in either place — but per this phase's own explicit rule, **a syntactically
 * valid routing/account combination is NOT a verified bank account**; passing these checks only means
 * the value is well-formed enough to submit for tokenization/verification, never proof an account
 * exists. No network access, no persistence — pure functions only.
 */

/** ABA routing-number checksum: 3*(d1+d4+d7) + 7*(d2+d5+d8) + 1*(d3+d6+d9) must be a multiple of 10. */
export function isValidRoutingNumber(routingNumber: string): boolean {
  if (!/^\d{9}$/.test(routingNumber)) return false;
  const d = routingNumber.split("").map(Number) as [number, number, number, number, number, number, number, number, number];
  const checksum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + 1 * (d[2] + d[5] + d[8]);
  return checksum % 10 === 0;
}

/** Most U.S. bank account numbers fall in this range; provider-side validation is the real gate. */
export function isValidAccountNumber(accountNumber: string): boolean {
  return /^\d{4,17}$/.test(accountNumber);
}

export function accountNumbersMatch(accountNumber: string, confirmAccountNumber: string): boolean {
  return accountNumber.length > 0 && accountNumber === confirmAccountNumber;
}
