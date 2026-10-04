import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessProfile } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type {
  BusinessProfileRecord,
  BusinessProfileRepository,
  BusinessProfileStatus,
  BusinessRepresentativeDetails,
} from "./businessProfileService";

type Row = typeof businessProfile.$inferSelect;

function toRecord(row: Row): BusinessProfileRecord {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    legalBusinessName: row.legalBusinessName,
    displayName: row.displayName,
    entityType: row.entityType,
    businessAddress: row.businessAddress,
    country: row.country,
    state: row.state,
    status: row.status,
    currency: row.currency,
    createdAt: row.createdAt,
    dbaName: row.dbaName,
    industry: row.industry,
    formationJurisdiction: row.formationJurisdiction,
    businessEmail: row.businessEmail,
    website: row.website,
    representative: row.representativeFirstName
      ? {
          firstName: row.representativeFirstName,
          lastName: row.representativeLastName ?? "",
          title: row.representativeTitle ?? "",
          email: row.representativeEmail ?? "",
          phone: row.representativePhone ?? "",
          relationshipToBusiness: row.representativeRelationship ?? "",
        }
      : null,
    onboardingStep: row.onboardingStep,
  };
}

export class DrizzleBusinessProfileRepository implements BusinessProfileRepository {
  async insert(input: {
    ownerUserId: string;
    legalBusinessName: string;
    displayName: string;
    entityType: string;
    businessAddress: unknown;
    country: string;
    state: string;
  }): Promise<BusinessProfileRecord> {
    const db = getDb();
    const [row] = await db
      .insert(businessProfile)
      .values({ ...input, businessAddress: input.businessAddress as object | null })
      .returning();
    if (!row) throw new ConfigurationError("business_profile insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<BusinessProfileRecord | null> {
    const db = getDb();
    const rows = await db.select().from(businessProfile).where(eq(businessProfile.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listByOwner(ownerUserId: string): Promise<BusinessProfileRecord[]> {
    const db = getDb();
    const rows = await db.select().from(businessProfile).where(eq(businessProfile.ownerUserId, ownerUserId));
    return rows.map(toRecord);
  }

  async updateStatus(id: string, status: BusinessProfileStatus): Promise<void> {
    const db = getDb();
    await db.update(businessProfile).set({ status }).where(eq(businessProfile.id, id));
  }

  async updateOnboardingDetails(
    id: string,
    input: {
      dbaName: string | null;
      industry: "TRUCKING" | "FREIGHT" | "THREE_PL" | "RETAIL" | "OTHER";
      formationJurisdiction: string;
      businessEmail: string;
      website: string | null;
      representative: BusinessRepresentativeDetails;
    },
  ): Promise<void> {
    const db = getDb();
    await db
      .update(businessProfile)
      .set({
        dbaName: input.dbaName,
        industry: input.industry,
        formationJurisdiction: input.formationJurisdiction,
        businessEmail: input.businessEmail,
        website: input.website,
        representativeFirstName: input.representative.firstName,
        representativeLastName: input.representative.lastName,
        representativeTitle: input.representative.title,
        representativeEmail: input.representative.email,
        representativePhone: input.representative.phone,
        representativeRelationship: input.representative.relationshipToBusiness,
        updatedAt: new Date(),
      })
      .where(eq(businessProfile.id, id));
  }

  async setOnboardingStep(id: string, step: "details_pending" | "details_complete" | "verification_submitted" | "tier_selected" | "billing_setup_complete"): Promise<void> {
    const db = getDb();
    await db.update(businessProfile).set({ onboardingStep: step, updatedAt: new Date() }).where(eq(businessProfile.id, id));
  }
}
