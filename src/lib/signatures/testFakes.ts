import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { InMemoryPersonalProfileRepository } from "@/lib/auth/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { grantStepUp } from "@/lib/staff/testFakes";
import { AgreementIdentitySnapshotService } from "@/lib/agreements/agreementIdentitySnapshotService";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import { InMemoryDocumentStorage, InMemoryProfileDisplayReader } from "@/lib/documents/testFakes";
import { InMemoryIdentityVerificationRecordRepository } from "@/lib/profiles/testFakes";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { SignatureService } from "./signatureService";
import type { AgreementPdfRecord, AgreementPdfRepository, SignatureEventRecord, SignatureEventRepository } from "./signatureService";

/** Test-only in-memory doubles for SignatureService, mirroring src/lib/agreements/testFakes.ts's pattern. */

export class InMemorySignatureEventRepository implements SignatureEventRepository {
  events: SignatureEventRecord[] = [];

  async insert(input: Omit<SignatureEventRecord, "id" | "signedAt">): Promise<SignatureEventRecord> {
    const record: SignatureEventRecord = { id: randomUUID(), signedAt: new Date(), ...input };
    this.events.push(record);
    return record;
  }

  async listForVersion(agreementVersionId: string): Promise<SignatureEventRecord[]> {
    return this.events.filter((e) => e.agreementVersionId === agreementVersionId);
  }
}

export class InMemoryAgreementPdfRepository implements AgreementPdfRepository {
  byVersionId = new Map<string, AgreementPdfRecord>();

  async insert(input: { id?: string; agreementVersionId: string; storagePath: string; documentHash: string }): Promise<AgreementPdfRecord> {
    const record: AgreementPdfRecord = { generatedAt: new Date(), ...input, id: input.id ?? randomUUID() };
    this.byVersionId.set(input.agreementVersionId, record);
    return record;
  }

  async findByVersion(agreementVersionId: string): Promise<AgreementPdfRecord | null> {
    return this.byVersionId.get(agreementVersionId) ?? null;
  }
}

class InMemoryAuditEventRepositoryForSignatures implements AuditEventRepository {
  events: AuditEventRecord[] = [];
  private nextId = 1;

  async getLastEvent(): Promise<AuditEventRecord | null> {
    return this.events.at(-1) ?? null;
  }

  async insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord> {
    const stored: AuditEventRecord = { ...record, id: this.nextId++ };
    this.events.push(stored);
    return stored;
  }
}

/**
 * Blocker 2 (amendment PDF lifecycle): builds a real SignatureService test double sharing an
 * ALREADY-CONSTRUCTED agreement test context, instead of creating its own — so a caller like
 * AmendmentService's own testFakes.ts (which needs a working `AmendmentPdfGenerator` sharing the
 * exact same `agreementCtx`/identity-snapshot state its amendment applies through) can get one.
 * `createTestSignatureService` below is a thin wrapper around this for its own, independent
 * agreementCtx — extracted with no behavior change to that existing, already-tested function.
 */
export function createSignatureServiceForAgreementContext(
  agreementCtx: ReturnType<typeof createTestAgreementService>,
  options?: {
    signatureEvents?: InMemorySignatureEventRepository;
    notifications?: import("@/lib/notify/notificationService").NotificationService;
  },
) {
  const signatureEvents = options?.signatureEvents ?? new InMemorySignatureEventRepository();
  const { mfaService, credentials: mfaCredentials, stepUps } = createTestMfaService();
  const agreementPdfs = new InMemoryAgreementPdfRepository();
  const profileDisplay = new InMemoryProfileDisplayReader();
  const storage = new InMemoryDocumentStorage();
  const auditRepo = new InMemoryAuditEventRepositoryForSignatures();
  const audit = new AuditService(auditRepo);
  // Decision 9 / Blocker 2: shares agreementCtx's own snapshotRepo/identitySource so SignatureService
  // reads the exact same frozen rows AgreementService.creditorDecide / AmendmentService.applyAmendment
  // freeze — mirroring production's shared getAgreementIdentitySnapshotService() singleton.
  const partySnapshots = new AgreementIdentitySnapshotService({
    snapshots: agreementCtx.snapshotRepo,
    identitySource: agreementCtx.identitySource,
  });

  const signatureService = new SignatureService({
    agreementService: agreementCtx.agreementService,
    mfa: mfaService,
    staffService: agreementCtx.staffCtx.staffService,
    profileOwners: agreementCtx.profileOwners,
    signatureEvents,
    agreementPdfs,
    profileDisplay,
    storage,
    audit,
    notifications: options?.notifications,
    partySnapshots,
  });

  return {
    signatureService,
    mfaService,
    mfaCredentials,
    stepUps,
    agreementPdfs,
    profileDisplay,
    storage,
    auditRepo,
    partySnapshots,
    signatureEvents,
  };
}

/**
 * Builds a full SignatureService test context, sharing the same underlying AgreementService,
 * profileOwners, and staffService/staffMembers instances the returned agreementService uses —
 * exactly as production does (getSignatureService() and getAgreementService() both resolve through
 * the same singletons) — so a party/staff member seeded once is visible to both services.
 */
/** `notifications`: optional (PRSprint 13, docs/prsprints/PRSPRINT_13_NOTIFICATION_EVENT_WIRING.md) — SignatureServiceDeps.notifications is itself optional; most callers omit it. */
export function createTestSignatureService(notifications?: import("@/lib/notify/notificationService").NotificationService) {
  const signatureEvents = new InMemorySignatureEventRepository();
  // PRSprint 12: shares its own `.events` array with the AgreementService context's atomic signing
  // path (InMemorySigningApplicationRepository) — see createTestAgreementService's own doc comment —
  // so SignatureService's reads here (generatePdf's listForVersion, this file's own assertions) see
  // the evidence the atomic apply wrote, matching how production's SignatureService and
  // AgreementService resolve through the same singletons.
  const agreementCtx = createTestAgreementService(signatureEvents.events);
  // Production follow-up (Remove Step 4 — Identity Verification): SignatureService no longer reads
  // verification state before signing, but verificationRecords/personalProfiles are kept here —
  // markFullyVerified/seedPersonalParty (used by other, unrelated test files for general party
  // setup) still operate on them directly.
  const verificationRecords = new InMemoryIdentityVerificationRecordRepository();
  const personalProfiles = new InMemoryPersonalProfileRepository();
  const shared = createSignatureServiceForAgreementContext(agreementCtx, { signatureEvents, notifications });

  return {
    ...shared,
    agreementCtx,
    verificationRecords,
    personalProfiles,
  };
}

/**
 * Test-only helper: registers a personal-profile party consistently across profileOwners (party
 * authorization) and personalProfiles (SignatureService's own-identity lookup) — the same
 * personal_profile.id is used for both, matching the real invariant that a personal party's
 * profileId on an agreement always is that user's personal_profile.id.
 */
export async function seedPersonalParty(
  ctx: ReturnType<typeof createTestSignatureService>,
  userId: string,
): Promise<string> {
  const profile = await ctx.personalProfiles.insert(userId);
  ctx.agreementCtx.profileOwners.set("personal", profile.id, userId);
  return profile.id;
}

/** Test-only helper: marks a profile FULL_VERIFIED without going through the real request/decide flow. */
export async function markFullyVerified(
  ctx: ReturnType<typeof createTestSignatureService>,
  profileKind: ProfileKind,
  profileId: string,
): Promise<void> {
  const record = await ctx.verificationRecords.insert({ profileKind, profileId, tier: "full" });
  await ctx.verificationRecords.updateDecision(record.id, {
    status: "verified",
    reviewerUserId: randomUUID(),
    reason: null,
  });
}

export { grantStepUp };
