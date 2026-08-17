import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ValidationError } from "@/lib/errors";

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

    const profile = await this.repo.insert(input);
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
