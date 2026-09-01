import "server-only";
import type { PartyRole } from "./agreementService";
import type { ProfileKind } from "@/lib/profiles/verificationService";

export interface AgreementPartySnapshotRecord {
  id: string;
  agreementId: string;
  agreementVersionId: string;
  role: PartyRole;
  profileKind: ProfileKind;
  /** Internal audit/reference only — see this record's own schema doc comment. Never printed anywhere agreement-facing. */
  sourceProfileId: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  preferredEmail: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  createdAt: Date;
}

export interface AgreementPartySnapshotRepository {
  insert(input: {
    agreementId: string;
    agreementVersionId: string;
    role: PartyRole;
    profileKind: ProfileKind;
    sourceProfileId: string;
    displayName: string;
    firstName: string | null;
    lastName: string | null;
    preferredEmail: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  }): Promise<AgreementPartySnapshotRecord>;
  findByVersionId(agreementVersionId: string): Promise<AgreementPartySnapshotRecord[]>;
}

export interface PartyIdentitySnapshotFields {
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  preferredEmail: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

/** Real implementation: DrizzlePartyIdentitySource. */
export interface PartyIdentitySource {
  getPartyIdentity(profileKind: ProfileKind, profileId: string): Promise<PartyIdentitySnapshotFields>;
}

export interface AgreementIdentitySnapshotServiceDeps {
  snapshots: AgreementPartySnapshotRepository;
  identitySource: PartyIdentitySource;
}

/**
 * Decision 7 (agreement identity snapshot). Timing: called once, from AgreementService.creditorDecide's
 * accept branch — the moment Step 2 completes and the agreement enters `awaiting_signatures` — never
 * deferred until signing. Idempotent per (agreement_version_id, role): a repeated call for a version
 * that already has both roles' snapshots is a no-op (also enforced at the DB level by
 * `agreement_party_snapshot_version_role_unique`). Historical snapshots are immutable — this class has
 * no update method, only insert-if-missing; an amendment's new version gets its OWN new rows.
 */
export class AgreementIdentitySnapshotService {
  constructor(private readonly deps: AgreementIdentitySnapshotServiceDeps) {}

  async freezeSnapshot(input: {
    agreementId: string;
    agreementVersionId: string;
    creditor: { kind: ProfileKind; id: string };
    debtor: { kind: ProfileKind; id: string };
  }): Promise<void> {
    const existing = await this.deps.snapshots.findByVersionId(input.agreementVersionId);
    const parties: Array<{ role: PartyRole; kind: ProfileKind; id: string }> = [
      { role: "creditor", kind: input.creditor.kind, id: input.creditor.id },
      { role: "debtor", kind: input.debtor.kind, id: input.debtor.id },
    ];
    for (const party of parties) {
      if (existing.some((e) => e.role === party.role)) continue;
      const identity = await this.deps.identitySource.getPartyIdentity(party.kind, party.id);
      await this.deps.snapshots.insert({
        agreementId: input.agreementId,
        agreementVersionId: input.agreementVersionId,
        role: party.role,
        profileKind: party.kind,
        sourceProfileId: party.id,
        ...identity,
      });
    }
  }

  /** Used by the on-screen agreement view and the PDF renderer — the one shared read, so screen and PDF can never disagree. */
  async getSnapshotForVersion(agreementVersionId: string): Promise<{ creditor: AgreementPartySnapshotRecord; debtor: AgreementPartySnapshotRecord } | null> {
    const rows = await this.deps.snapshots.findByVersionId(agreementVersionId);
    const creditor = rows.find((r) => r.role === "creditor");
    const debtor = rows.find((r) => r.role === "debtor");
    if (!creditor || !debtor) return null;
    return { creditor, debtor };
  }
}
