import "server-only";
import { ValidationError } from "@/lib/errors";
import { CURRENT_LEGAL_DOCUMENT_VERSIONS, isLegalDocumentType, type LegalDocumentType } from "./legalDocumentVersions";
import type { LegalAcceptanceRecord, LegalAcceptanceRepository } from "./legalAcceptanceRepository";

export interface LegalDocumentAcceptanceStatus {
  documentType: LegalDocumentType;
  requiredVersion: string;
  accepted: boolean;
  acceptedVersion: string | null;
  acceptedAt: string | null;
}

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 3/4/8/9: the one service that may ever
 * write to `legal_acceptance`. Acceptance is ALWAYS server-controlled —
 * `CURRENT_LEGAL_DOCUMENT_VERSIONS` resolves the version, `acceptedAt` is this process's own clock,
 * `userId`/`organizationId` come only from an already-authenticated/authorized caller (this class
 * itself takes no session/request — see `BusinessOnboardingService.acceptLegalDocument`'s own doc
 * comment for where the caller is verified to actually own the organization). A caller can never pass
 * a version at all — there is no parameter for one — so "client-supplied document version not
 * currently offered" is structurally impossible, not merely validated away.
 */
export class LegalAcceptanceService {
  constructor(private readonly repo: LegalAcceptanceRepository) {}

  /**
   * Idempotent: re-submitting an acceptance the SAME user already recorded for the SAME current
   * version is a no-op (returns the existing row, never a duplicate) — Section 9's "do not force
   * re-acceptance merely because [it was already accepted]." A genuinely NEW version always inserts a
   * fresh row; the old one is left in place as history, never mutated (append-only, matching this
   * codebase's established identity_verification_record-style pattern).
   */
  async recordAcceptance(input: { userId: string; organizationId: string | null; documentType: string; metadata?: Record<string, unknown> | null }): Promise<LegalAcceptanceRecord> {
    if (!isLegalDocumentType(input.documentType)) {
      throw new ValidationError(`"${input.documentType}" is not a recognized legal document type.`);
    }
    const documentVersion = CURRENT_LEGAL_DOCUMENT_VERSIONS[input.documentType];

    const existing = await this.repo.findCurrent({ userId: input.userId, organizationId: input.organizationId, documentType: input.documentType, documentVersion });
    if (existing) return existing;

    return this.repo.insert({
      userId: input.userId,
      organizationId: input.organizationId,
      documentType: input.documentType,
      documentVersion,
      acceptedAt: new Date(),
      metadata: input.metadata ?? null,
    });
  }

  /**
   * Organization-scoped status for each requested document type — current version, whether THIS
   * organization has recorded an acceptance of exactly that version (an acceptance of an OLDER
   * version never counts as current — Section 9), and when. Used both by the onboarding legal-gate UI
   * and by `BusinessActivationService`'s own independent activation check.
   */
  async getOrganizationAcceptanceStatus(organizationId: string, documentTypes: readonly LegalDocumentType[]): Promise<LegalDocumentAcceptanceStatus[]> {
    return Promise.all(
      documentTypes.map(async (documentType) => {
        const requiredVersion = CURRENT_LEGAL_DOCUMENT_VERSIONS[documentType];
        const current = await this.repo.findCurrentForOrganization({ organizationId, documentType, documentVersion: requiredVersion });
        return {
          documentType,
          requiredVersion,
          accepted: current !== null,
          acceptedVersion: current?.documentVersion ?? null,
          acceptedAt: current ? current.acceptedAt.toISOString() : null,
        };
      }),
    );
  }

  async hasAllCurrentAcceptances(organizationId: string, documentTypes: readonly LegalDocumentType[]): Promise<boolean> {
    const status = await this.getOrganizationAcceptanceStatus(organizationId, documentTypes);
    return status.every((s) => s.accepted);
  }
}
