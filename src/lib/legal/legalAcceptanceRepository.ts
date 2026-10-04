import "server-only";

export interface LegalAcceptanceRecord {
  id: string;
  userId: string;
  organizationId: string | null;
  documentType: string;
  documentVersion: string;
  acceptedAt: Date;
  metadata: Record<string, unknown> | null;
}

/**
 * Real implementation: DrizzleLegalAcceptanceRepository. Deliberately minimal — `LegalAcceptanceService`
 * is the only caller, and it alone owns version resolution, document-type validation, and idempotency
 * (never re-inserting an acceptance that already exists for the exact same type+version+scope).
 */
export interface LegalAcceptanceRepository {
  insert(input: {
    userId: string;
    organizationId: string | null;
    documentType: string;
    documentVersion: string;
    acceptedAt: Date;
    metadata: Record<string, unknown> | null;
  }): Promise<LegalAcceptanceRecord>;
  /**
   * Exact-match lookup (same user, same scope, same type+version) — used only for idempotency so
   * the SAME user re-submitting an acceptance they already recorded never creates a duplicate row.
   * `organizationId: null` matches only rows ALSO recorded with a null organizationId (a
   * Personal-scope acceptance) — never "any organization."
   */
  findCurrent(input: { userId: string; organizationId: string | null; documentType: string; documentVersion: string }): Promise<LegalAcceptanceRecord | null>;
  /**
   * Organization-scoped lookup, independent of WHICH user accepted — the activation-gate question is
   * "has this organization's acceptance of this exact document version been recorded at all" (by
   * whoever was its authorized billing administrator at the time), never "has the CURRENT owner
   * specifically accepted it." Tenant isolation is structural: filters on the exact organizationId,
   * so one organization's acceptance can never satisfy another's lookup (Section 24's cross-tenant
   * requirement).
   */
  findCurrentForOrganization(input: { organizationId: string; documentType: string; documentVersion: string }): Promise<LegalAcceptanceRecord | null>;
  /** Every acceptance ever recorded for this organization (audit/display) — tenant-scoped by construction. */
  listForOrganization(organizationId: string): Promise<LegalAcceptanceRecord[]>;
}
