export interface B2BUpcomingPayment {
  agreementId: string;
  role: "creditor" | "debtor";
  dueDate: string;
  amountMinorUnits: number;
}

export interface B2BDashboardData {
  activeAgreementsCount: number;
  accountsReceivableMinorUnits: number;
  accountsPayableMinorUnits: number;
  upcomingPayments: B2BUpcomingPayment[];
  pastDuePayments: B2BUpcomingPayment[];
  // Reserved — Sprint 15 (settlements) and Sprint 16 (disputes) don't exist yet. Honestly empty,
  // not fabricated, matching Sprint 3's own "No fake financial data" precedent for this same
  // dashboard surface.
  settlements: never[];
  disputes: never[];
}

/** Real implementation: DrizzleB2BDashboardReader. Read-only aggregate queries only, scoped to one business profile. */
export interface B2BDashboardReader {
  getDashboard(businessProfileId: string): Promise<B2BDashboardData>;
}
