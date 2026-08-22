import "server-only";
import type { AgreementRecord, AgreementService } from "@/lib/agreements/agreementService";
import type { ProfileAccessService } from "@/lib/profiles/profileAccessService";
import type { ConsentRecord, ConsentService } from "./consentService";

export interface UserDataExport {
  exportedAt: string;
  userId: string;
  email: string;
  profiles: Array<{ kind: "personal" | "business"; id: string; displayName: string }>;
  agreements: AgreementRecord[];
  consents: ConsentRecord[];
}

export interface UserAccountReader {
  getEmailByUserId(userId: string): Promise<string | null>;
}

/**
 * PRSprint 32 (docs/prsprints/PRSPRINT_32_COMPLIANCE_HOOKS_CONSENT_PRIVACY_RETENTION.md): master-spec
 * item 117, "Add user data export where appropriate... users should be able to retrieve appropriate
 * records: agreements; payment history; documents." Ships the concrete, verifiable slice first —
 * account/profile identity, every agreement the user is a party to (via any of their profiles, using
 * AgreementService.listAgreements exactly as the authenticated agreements list already does — no
 * separate, second query path that could drift from what "my agreements" already means elsewhere),
 * and their own consent history.
 *
 * Deliberately does not yet include payment/ledger line items, documents/evidence, or notification
 * history — see the PRSprint 32 completion report's "known limitations": those each have their own
 * per-agreement authorization shape (ledger entries are read via BalanceService per-agreement, not a
 * per-user query; evidence/PDF retrieval goes through signed-URL flows) that would need their own
 * careful review to fold into a single export without a new, parallel, easily-drifting access path.
 * This export already gives a user everything needed to identify *which* agreements to review directly
 * in the app, where that per-agreement detail (including payment history) is already fully visible.
 */
export class DataExportService {
  constructor(
    private readonly deps: {
      profileAccess: ProfileAccessService;
      agreements: AgreementService;
      consents: ConsentService;
      accounts: UserAccountReader;
    },
  ) {}

  async exportForUser(userId: string): Promise<UserDataExport> {
    const email = await this.deps.accounts.getEmailByUserId(userId);
    const profiles = await this.deps.profileAccess.listSelectableProfiles(userId);

    const agreementsByid = new Map<string, AgreementRecord>();
    for (const profile of profiles) {
      const ref =
        profile.kind === "personal" ? { kind: "personal" as const, id: profile.personalProfileId! } : { kind: "business" as const, id: profile.businessProfileId! };
      const agreements = await this.deps.agreements.listAgreements(userId, ref);
      for (const agreement of agreements) agreementsByid.set(agreement.id, agreement);
    }

    const consents = await this.deps.consents.listConsentsForUser(userId);

    return {
      exportedAt: new Date().toISOString(),
      userId,
      email: email ?? "",
      profiles: profiles.map((p) => ({
        kind: p.kind,
        id: (p.kind === "personal" ? p.personalProfileId : p.businessProfileId)!,
        displayName: p.displayName,
      })),
      agreements: [...agreementsByid.values()],
      consents,
    };
  }
}
