/**
 * Sprint 18B relationship setup tracker. Built entirely from
 * RelationshipService.checkActivationPrerequisites's own machine-readable
 * `reasons` (via GET /api/relationships/activate/check) — never inferred
 * from client-side form submission, matching the 18B prompt's explicit
 * "Re-fetch authoritative backend state. Do not infer completion from
 * client form submission."
 */
export interface SetupStep {
  label: string;
  complete: boolean;
}

const FUNDING_REASONS = ["funding_account_missing", "funding_account_unverified", "mandate_missing", "card_missing"];
const PAYOUT_REASONS = ["payout_account_missing", "payout_account_unverified"];

export function buildSetupSteps(reasons: string[], relationshipStatus: string): SetupStep[] {
  const has = (r: string) => reasons.includes(r);
  const hasAny = (list: string[]) => list.some((r) => reasons.includes(r));
  return [
    { label: "Counterparty connected", complete: !has("counterparty_missing") },
    { label: "Funding account ready", complete: !hasAny(FUNDING_REASONS) },
    { label: "Receiving account ready", complete: !hasAny(PAYOUT_REASONS) },
    { label: "Agreement ready", complete: !has("agreement_missing") },
    { label: "Signatures complete", complete: !has("signature_missing") && !has("agreement_missing") },
    { label: "Relationship active", complete: relationshipStatus === "active" },
  ];
}
