import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ValidationError } from "@/lib/errors";
import type { AtomicBusinessProfileCreator } from "./atomicBusinessProfileCreator";

export type BusinessProfileStatus = "active" | "disabled" | "deleted";

export interface BusinessProfileRecord {
  id: string;
  ownerUserId: string;
  legalBusinessName: string;
  displayName: string;
  entityType: string;
  businessAddress: unknown;
  country: string;
  state: string;
  status: BusinessProfileStatus;
  currency: string;
  createdAt: Date;
}

export interface BusinessProfileRepository {
  /**
   * Checkpoint review 2026-10-02: NEVER call this directly to create a real organization — it
   * cannot also create the required OWNER `business_staff_member` row, and the two would not be
   * atomic even if you tried to call both yourself. `BusinessProfileService.createBusinessProfile`
   * uses `AtomicBusinessProfileCreator` instead (see atomicBusinessProfileCreator.ts). This method
   * remains on the interface only for read-path symmetry with findById/listByOwner/updateStatus,
   * and because `InMemoryBusinessProfileRepository`'s own test double still needs a way to seed
   * profiles in isolation (e.g. createTestProfileAccessService, which never creates staff).
   */
  insert(input: {
    ownerUserId: string;
    legalBusinessName: string;
    displayName: string;
    entityType: string;
    businessAddress: unknown;
    country: string;
    state: string;
  }): Promise<BusinessProfileRecord>;
  findById(id: string): Promise<BusinessProfileRecord | null>;
  listByOwner(ownerUserId: string): Promise<BusinessProfileRecord[]>;
  /**
   * PRSprint 11B (docs/prsprints/PRSPRINT_11B_ADMIN_CONSOLE_CONTROLLED_SUPPORT_ACCESS.md): no
   * production code path could change a business profile's lifecycle status at all before this —
   * `status` only ever existed as a schema column and a test-only in-memory helper
   * (InMemoryBusinessProfileRepository.setStatus). Added so AdminService can suspend/reactivate a
   * business the same way it already does for a user account.
   */
  updateStatus(id: string, status: BusinessProfileStatus): Promise<void>;
}

/**
 * Sprint 3 (docs/sprints/SPRINT_03_Personal_Business_Profiles.md): "A user
 * may create multiple separately verified business profiles." No limit is
 * enforced here — the only DB-level guard is a soft uniqueness constraint
 * on (owner, legal name) (src/db/schema/identity.ts), not a count cap.
 */
export class BusinessProfileService {
  constructor(
    private readonly repo: BusinessProfileRepository,
    private readonly audit: AuditService,
    // Checkpoint review 2026-10-02: mandatory, not optional. The prior "optional dependency so
    // existing test callers keep compiling" shape was itself the defect this fix closes — it meant
    // a caller could legally construct this service and get the old (owner-membership-less)
    // behavior back by simply omitting the third argument, with no compiler or runtime signal that
    // anything was missing. There is now exactly one way to create a business_profile, and it is
    // always atomic with its OWNER membership (see AtomicBusinessProfileCreator's own doc comment).
    private readonly profileCreator: AtomicBusinessProfileCreator,
  ) {}

  async createBusinessProfile(input: {
    ownerUserId: string;
    legalBusinessName: string;
    displayName: string;
    entityType: string;
    businessAddress: unknown;
    country: string;
    state: string;
  }): Promise<BusinessProfileRecord> {
    if (!input.legalBusinessName.trim()) throw new ValidationError("Legal business name is required.");
    if (!input.displayName.trim()) throw new ValidationError("Display name is required.");
    if (!input.entityType.trim()) throw new ValidationError("Entity type is required.");
    if (!input.state.trim()) throw new ValidationError("State is required.");

    // Defect fix (Phase 0 inventory, 2026-10-02): business profile creation never used to seed an
    // OWNER business_staff_member row for the creating user, so the owner could never pass their
    // own StaffService.requireActiveStaff gate — the concrete reason the entire organization nav
    // section has been stubbed "Coming Soon". Checkpoint review (same date): the fix must be
    // atomic, not "insert profile, then separately try to insert membership" — see
    // AtomicBusinessProfileCreator's own doc comment for why. Every active business_profile now
    // comes into existence with its OWNER membership already present, in the same transaction.
    const { profile } = await this.profileCreator.createAtomically(input);

    await this.audit.record({
      actorUserId: input.ownerUserId,
      actorRole: "personal_user",
      profileKind: "business",
      profileId: profile.id,
      agreementId: null,
      action: "business_profile_created",
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: { legalBusinessName: profile.legalBusinessName },
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
    });
    return profile;
  }

  async listMyBusinessProfiles(ownerUserId: string): Promise<BusinessProfileRecord[]> {
    return this.repo.listByOwner(ownerUserId);
  }

  /** Cross-user isolation: returns null (never someone else's profile) if the caller isn't the owner. */
  async getOwnedBusinessProfile(ownerUserId: string, businessProfileId: string): Promise<BusinessProfileRecord | null> {
    const profile = await this.repo.findById(businessProfileId);
    if (!profile || profile.ownerUserId !== ownerUserId) return null;
    return profile;
  }
}
