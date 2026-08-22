import "server-only";
import { ValidationError } from "@/lib/errors";

export type ConsentPolicyType = "terms_of_service" | "privacy_policy" | "electronic_communications_consent" | "sms_consent";

export interface ConsentRecord {
  id: string;
  userId: string;
  policyType: ConsentPolicyType;
  policyVersion: string;
  consentedAt: Date;
  method: string;
  ipAddress: string | null;
}

/** Real implementation: DrizzleConsentRepository. Append-only — no update/delete method exists, by design. */
export interface ConsentRepository {
  insert(input: { userId: string; policyType: ConsentPolicyType; policyVersion: string; method: string; ipAddress: string | null }): Promise<ConsentRecord>;
  listForUser(userId: string): Promise<ConsentRecord[]>;
}

/**
 * PRSprint 32 (docs/prsprints/PRSPRINT_32_COMPLIANCE_HOOKS_CONSENT_PRIVACY_RETENTION.md): generic
 * consent-capture service — master-spec items 99-100. Records *that* a user consented to a specific
 * version of a policy, when, and how; deliberately has no opinion on the policy's content (that is
 * counsel-reviewed text published elsewhere — see docs/COMPLIANCE_REVIEW_CHECKLIST.md, which this
 * class does not resolve any item on).
 *
 * Not currently wired to gate signup or any other flow — see the PRSprint 32 completion report for
 * why: the Terms of Service and Privacy Policy pages are still explicit "not yet finalized, not
 * reviewed by counsel" placeholders (src/components/LegalPlaceholder.tsx); requiring a legally
 * meaningful "I agree" to placeholder text would itself be a UDAP-adjacent risk (checklist item L14),
 * not a fix. This class exists so that once real, counsel-approved policy text is published, wiring
 * consent capture at signup is a one-line call to `recordConsent`, not a new capability to build.
 */
export class ConsentService {
  constructor(private readonly deps: { consents: ConsentRepository }) {}

  async recordConsent(input: {
    userId: string;
    policyType: ConsentPolicyType;
    policyVersion: string;
    method: string;
    ipAddress: string | null;
  }): Promise<ConsentRecord> {
    if (!input.policyVersion.trim()) {
      throw new ValidationError("A policy version is required to record consent.");
    }
    if (!input.method.trim()) {
      throw new ValidationError("A capture method is required to record consent.");
    }
    return this.deps.consents.insert(input);
  }

  /** A user's own consent history — evidence they can review, and the same data `exportUserData` (src/lib/compliance/dataExportService.ts) includes. */
  async listConsentsForUser(userId: string): Promise<ConsentRecord[]> {
    return this.deps.consents.listForUser(userId);
  }
}
