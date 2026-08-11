import "server-only";
import type {
  AgreementRecord,
  AgreementRepository,
  AgreementService,
  AgreementVersionRecord,
  AgreementVersionRepository,
  InstallmentScheduleItemRepository,
} from "@/lib/agreements/agreementService";
import type { ScheduleItem } from "@/lib/agreements/schedule";
import type { PersonalProfileRepository } from "@/lib/auth/authService";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { ProfileOwnerReader, VerificationService } from "@/lib/profiles/verificationService";

export interface AgreementWitnessRecord {
  id: string;
  agreementId: string;
  witnessUserId: string;
  addedByUserId: string;
  addedAt: Date;
  attestedVersionId: string | null;
  attestedAt: Date | null;
  ipAddress: string | null;
  deviceInfo: unknown;
}

export const MAX_WITNESSES_PER_AGREEMENT = 2;

/** Real implementation: DrizzleAgreementWitnessRepository. */
export interface AgreementWitnessRepository {
  insert(input: { agreementId: string; witnessUserId: string; addedByUserId: string }): Promise<AgreementWitnessRecord>;
  listForAgreement(agreementId: string): Promise<AgreementWitnessRecord[]>;
  findByAgreementAndUser(agreementId: string, userId: string): Promise<AgreementWitnessRecord | null>;
  recordAttestation(
    id: string,
    input: { attestedVersionId: string; attestedAt: Date; ipAddress: string | null; deviceInfo: unknown },
  ): Promise<void>;
}

export interface WitnessServiceDeps {
  agreementService: AgreementService;
  witnesses: AgreementWitnessRepository;
  // Read-only usage only — WitnessService never calls any mutating method on these, so a witness's
  // own view of an agreement can never become a path to altering it. Kept separate from
  // AgreementService's own authorization (which only ever authorizes parties, never witnesses) —
  // see getWitnessView's doc comment for why that separation matters.
  agreements: AgreementRepository;
  versions: AgreementVersionRepository;
  scheduleItems: InstallmentScheduleItemRepository;
  personalProfiles: PersonalProfileRepository;
  profileOwners: ProfileOwnerReader;
  verification: VerificationService;
  audit: AuditService;
}

export interface WitnessView {
  agreement: AgreementRecord;
  version: AgreementVersionRecord;
  schedule: ScheduleItem[];
}

/**
 * Sprint 7 (docs/sprints/SPRINT_07_Evidence_Documents_Witnesses.md) witnesses. This class has no
 * method that amends terms, initiates or receives a payment, or approves a settlement — those
 * capabilities do not exist here at all, by construction, matching the sprint's "cannot amend...
 * cannot receive funds... cannot approve settlement." A witness is never added to `agreement_party`
 * and AgreementService has no notion of "witness" anywhere in its authorization — a witness
 * therefore has zero standing to call `signAgreement`/`creditorDecide`/etc, proven by this sprint's
 * tests calling those methods directly with a witness's user id.
 */
export class WitnessService {
  constructor(private readonly deps: WitnessServiceDeps) {}

  async addWitness(input: {
    agreementId: string;
    actingUserId: string;
    witnessUserId: string;
    ipAddress: string | null;
    deviceInfo: unknown;
  }): Promise<AgreementWitnessRecord> {
    // Only an actual party may add a witness — reuses AgreementService's own party-authorization
    // primitive rather than re-implementing it.
    await this.deps.agreementService.resolvePartyRole(input.agreementId, input.actingUserId);

    if (input.witnessUserId === input.actingUserId) {
      throw new ValidationError("You cannot add yourself as a witness.");
    }

    const agreement = await this.deps.agreements.findById(input.agreementId);
    if (!agreement) throw new ValidationError("Agreement not found.");
    const [creditorOwner, debtorOwner] = await Promise.all([
      this.deps.profileOwners.getOwnerUserId(agreement.creditorProfileKind, agreement.creditorProfileId),
      this.deps.profileOwners.getOwnerUserId(agreement.debtorProfileKind, agreement.debtorProfileId),
    ]);
    if (input.witnessUserId === creditorOwner || input.witnessUserId === debtorOwner) {
      throw new ValidationError("A party to the agreement cannot also be a witness.");
    }

    const existing = await this.deps.witnesses.listForAgreement(input.agreementId);
    if (existing.some((w) => w.witnessUserId === input.witnessUserId)) {
      throw new ValidationError("This user is already a witness on this agreement.");
    }
    if (existing.length >= MAX_WITNESSES_PER_AGREEMENT) {
      throw new ValidationError(`An agreement may have at most ${MAX_WITNESSES_PER_AGREEMENT} witnesses.`);
    }

    const witnessPersonalProfile = await this.deps.personalProfiles.findByUserId(input.witnessUserId);
    if (!witnessPersonalProfile) {
      throw new ValidationError("The proposed witness has no personal profile.");
    }
    const verified = await this.deps.verification.isFullyVerified("personal", witnessPersonalProfile.id);
    if (!verified) {
      throw new ValidationError("The proposed witness must complete identity verification before being added.");
    }

    const record = await this.deps.witnesses.insert({
      agreementId: input.agreementId,
      witnessUserId: input.witnessUserId,
      addedByUserId: input.actingUserId,
    });
    await this.recordAudit(input.actingUserId, input.agreementId, "witness_added", input.ipAddress, input.deviceInfo, {
      witnessUserId: input.witnessUserId,
    });
    return record;
  }

  async listWitnesses(agreementId: string, actingUserId: string): Promise<AgreementWitnessRecord[]> {
    // Either a party or the witness themselves may see the roster.
    const isWitness = await this.deps.witnesses.findByAgreementAndUser(agreementId, actingUserId);
    if (!isWitness) {
      await this.deps.agreementService.resolvePartyRole(agreementId, actingUserId);
    }
    return this.deps.witnesses.listForAgreement(agreementId);
  }

  /**
   * Attests to the agreement's exact *current* version — "may attest only to exact version." Once
   * recorded, `attestedVersionId` is never updated again for this witness row (no method exists to
   * change it), matching a signature's own immutability.
   */
  async attest(input: { agreementId: string; actingUserId: string; ipAddress: string | null; deviceInfo: unknown }): Promise<void> {
    const witnessRow = await this.deps.witnesses.findByAgreementAndUser(input.agreementId, input.actingUserId);
    if (!witnessRow) {
      throw new ForbiddenError("You are not a witness on this agreement.");
    }
    if (witnessRow.attestedVersionId) {
      throw new ValidationError("You have already attested to this agreement.");
    }
    const agreement = await this.deps.agreements.findById(input.agreementId);
    if (!agreement?.currentVersionId) {
      throw new ValidationError("This agreement has no current version to attest to.");
    }
    const attestedAt = new Date();
    await this.deps.witnesses.recordAttestation(witnessRow.id, {
      attestedVersionId: agreement.currentVersionId,
      attestedAt,
      ipAddress: input.ipAddress,
      deviceInfo: input.deviceInfo,
    });
    await this.recordAudit(input.actingUserId, input.agreementId, "witness_attested", input.ipAddress, input.deviceInfo, {
      attestedVersionId: agreement.currentVersionId,
    });
  }

  /**
   * A witness's own read-only view — deliberately does NOT call AgreementService.getAgreement,
   * which only ever authorizes an actual party (creditor/debtor) and would reject a witness. This
   * method is witness access's *only* gate: membership in `agreement_witness`. It reads the same
   * underlying repositories AgreementService itself reads, never any mutating method.
   */
  async getWitnessView(agreementId: string, actingUserId: string): Promise<WitnessView> {
    const witnessRow = await this.deps.witnesses.findByAgreementAndUser(agreementId, actingUserId);
    if (!witnessRow) {
      throw new ForbiddenError("You are not a witness on this agreement.");
    }
    const agreement = await this.deps.agreements.findById(agreementId);
    if (!agreement) throw new ValidationError("Agreement not found.");
    if (!agreement.currentVersionId) throw new ValidationError("This agreement has no current version.");
    const version = await this.deps.versions.findById(agreement.currentVersionId);
    if (!version) throw new ValidationError("Agreement version not found.");
    const schedule = await this.deps.scheduleItems.listForVersion(version.id);
    return { agreement, version, schedule };
  }

  private async recordAudit(
    actorUserId: string,
    agreementId: string,
    action: string,
    ipAddress: string | null,
    deviceInfo: unknown,
    newValue: unknown,
  ): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "witness",
      profileKind: null,
      profileId: null,
      agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress,
      deviceInfo,
      previousValue: null,
      newValue,
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
    });
  }
}
