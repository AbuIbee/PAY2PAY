import "server-only";
import { getDb } from "@/db/client";
import { agreementParty } from "@/db/schema";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import type { AgreementPartyRepository, PartyRole } from "./agreementService";

export class DrizzleAgreementPartyRepository implements AgreementPartyRepository {
  async insert(input: { agreementId: string; role: PartyRole; profileKind: ProfileKind; profileId: string }): Promise<void> {
    const db = getDb();
    await db.insert(agreementParty).values(input);
  }
}
