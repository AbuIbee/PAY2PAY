import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreementPartySnapshot } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import type { PartyRole } from "./agreementService";
import type { AgreementPartySnapshotRecord, AgreementPartySnapshotRepository } from "./agreementIdentitySnapshotService";

type Row = typeof agreementPartySnapshot.$inferSelect;

function toRecord(row: Row): AgreementPartySnapshotRecord {
  return {
    id: row.id,
    agreementId: row.agreementId,
    agreementVersionId: row.agreementVersionId,
    role: row.role as PartyRole,
    profileKind: row.profileKind as ProfileKind,
    sourceProfileId: row.sourceProfileId,
    displayName: row.displayName,
    firstName: row.firstName,
    lastName: row.lastName,
    preferredEmail: row.preferredEmail,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    country: row.country,
    createdAt: row.createdAt,
  };
}

export class DrizzleAgreementPartySnapshotRepository implements AgreementPartySnapshotRepository {
  async insert(input: {
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
  }): Promise<AgreementPartySnapshotRecord> {
    const db = getDb();
    const [row] = await db.insert(agreementPartySnapshot).values(input).returning();
    if (!row) throw new ConfigurationError("agreement_party_snapshot insert returned no row");
    return toRecord(row);
  }

  async findByVersionId(agreementVersionId: string): Promise<AgreementPartySnapshotRecord[]> {
    const db = getDb();
    const rows = await db.select().from(agreementPartySnapshot).where(eq(agreementPartySnapshot.agreementVersionId, agreementVersionId));
    return rows.map(toRecord);
  }
}
