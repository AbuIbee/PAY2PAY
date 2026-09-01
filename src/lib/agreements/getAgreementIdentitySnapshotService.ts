import "server-only";
import { AgreementIdentitySnapshotService } from "./agreementIdentitySnapshotService";
import { DrizzleAgreementPartySnapshotRepository } from "./drizzleAgreementPartySnapshotRepository";
import { DrizzlePartyIdentitySource } from "./drizzlePartyIdentitySource";

let cached: AgreementIdentitySnapshotService | null = null;

/** Lazily creates (and memoizes) the production AgreementIdentitySnapshotService. */
export function getAgreementIdentitySnapshotService(): AgreementIdentitySnapshotService {
  if (!cached) {
    cached = new AgreementIdentitySnapshotService({
      snapshots: new DrizzleAgreementPartySnapshotRepository(),
      identitySource: new DrizzlePartyIdentitySource(),
    });
  }
  return cached;
}
