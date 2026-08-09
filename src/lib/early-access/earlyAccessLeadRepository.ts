export interface EarlyAccessLeadInput {
  name: string;
  email: string;
  accountType: "individual" | "business";
  businessName: string | null;
  state: string;
  intendedUse: string;
  expectedAgreementsPerMonth: number;
  notes: string | null;
  source: string;
  consentVersion: string;
}

export interface EarlyAccessLeadRecord {
  id: string;
}

/**
 * Sprint 1's early-access lead capture. `upsertByEmail` is idempotent by
 * design (Sprint 1 item 8, duplicate handling): resubmitting the same email
 * updates the existing lead's details rather than creating a second row or
 * erroring.
 */
export interface EarlyAccessLeadRepository {
  upsertByEmail(input: EarlyAccessLeadInput): Promise<EarlyAccessLeadRecord>;
}
