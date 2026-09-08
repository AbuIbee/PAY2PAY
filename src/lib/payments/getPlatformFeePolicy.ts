import "server-only";
import { DefaultPlatformFeePolicy, type PlatformFeePolicy } from "./platformFeePolicy";

let cached: PlatformFeePolicy | null = null;

/**
 * PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 2 — CENTRALIZE PAID2YOU
 * PLATFORM-FEE AUTHORITY). The ONE production singleton every provider-routed payment path — normal
 * webhook-receipt ledger posting AND ambiguous provider-outcome reconstruction alike — must obtain
 * `platformFeeMinorUnits` from. Never construct a second `DefaultPlatformFeePolicy` (or any other
 * implementation) directly in a production call site; always go through this getter, mirroring every
 * other shared-singleton factory in this codebase (`getPaymentProvider`, `getLedgerService`, etc.).
 */
export function getPlatformFeePolicy(): PlatformFeePolicy {
  if (!cached) {
    cached = new DefaultPlatformFeePolicy();
  }
  return cached;
}
