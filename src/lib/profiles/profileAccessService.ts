import "server-only";
import type { PersonalProfileRepository } from "@/lib/auth/authService";
import { AuthenticationError, ForbiddenError, ValidationError } from "@/lib/errors";
import type { BusinessProfileRepository } from "./businessProfileService";

export type ActiveProfileSelector = { kind: "personal" } | { kind: "business"; businessProfileId: string };

export interface ActiveProfileResult {
  kind: "personal" | "business";
  personalProfileId?: string;
  businessProfileId?: string;
  displayName: string;
}

/**
 * Sprint 3 (docs/sprints/SPRINT_03_Personal_Business_Profiles.md): "The
 * active profile must be explicit. Authorization may not trust an arbitrary
 * profile_id from the browser. Every server action must verify that the
 * authenticated user has permission for the selected profile." This is the
 * single seam that verifies that, so no caller re-derives (and potentially
 * gets wrong) its own ownership check.
 */
export class ProfileAccessService {
  constructor(
    private readonly personalProfiles: PersonalProfileRepository,
    private readonly businessProfiles: BusinessProfileRepository,
  ) {}

  async resolveActiveProfile(userId: string, selector: ActiveProfileSelector): Promise<ActiveProfileResult> {
    if (selector.kind === "personal") {
      const profile = await this.personalProfiles.findByUserId(userId);
      if (!profile) {
        // Should not happen post-Sprint-2 (signup always creates one), but
        // never silently substitute someone else's profile if it does.
        throw new AuthenticationError("No personal profile found for this account.");
      }
      return { kind: "personal", personalProfileId: profile.id, displayName: "Personal" };
    }

    const business = await this.businessProfiles.findById(selector.businessProfileId);
    if (!business || business.ownerUserId !== userId) {
      // Cross-user isolation / "unauthorized profile switching blocked" —
      // never trust the browser-supplied businessProfileId without this check.
      throw new ForbiddenError("You do not have access to this business profile.");
    }
    if (business.status !== "active") {
      // "Deleted/disabled business cannot be selected."
      throw new ValidationError("This business profile is not available.");
    }

    return { kind: "business", businessProfileId: business.id, displayName: business.displayName };
  }

  /** For the switcher UI: every profile the user is allowed to select. */
  async listSelectableProfiles(userId: string): Promise<ActiveProfileResult[]> {
    const results: ActiveProfileResult[] = [];
    const personal = await this.personalProfiles.findByUserId(userId);
    if (personal) {
      results.push({ kind: "personal", personalProfileId: personal.id, displayName: "Personal" });
    }
    const businesses = await this.businessProfiles.listByOwner(userId);
    for (const business of businesses) {
      if (business.status !== "active") continue; // never offer a disabled/deleted business
      results.push({ kind: "business", businessProfileId: business.id, displayName: business.displayName });
    }
    return results;
  }
}
