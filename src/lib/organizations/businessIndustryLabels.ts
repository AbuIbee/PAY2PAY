import type { BusinessIndustry } from "@/lib/profiles/businessProfileService";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Requirement 16: the ONE place the "THREE_PL" ->
 * "3PL" UI-label mapping lives — the SQL enum value cannot start with a digit, but every rendered
 * surface (onboarding, future dashboard copy) must say "3PL", never "THREE_PL" or "Three Pl".
 * Industry is display/terminology only — this file must never be consulted by any authorization
 * decision (Requirement 16's own guardrail).
 */
export const BUSINESS_INDUSTRY_LABELS: Readonly<Record<BusinessIndustry, string>> = {
  TRUCKING: "Trucking",
  FREIGHT: "Freight",
  THREE_PL: "3PL",
  RETAIL: "Retail",
  OTHER: "Other",
};

export const BUSINESS_INDUSTRY_VALUES: readonly BusinessIndustry[] = ["TRUCKING", "FREIGHT", "THREE_PL", "RETAIL", "OTHER"];

export function businessIndustryLabel(industry: BusinessIndustry): string {
  return BUSINESS_INDUSTRY_LABELS[industry];
}
