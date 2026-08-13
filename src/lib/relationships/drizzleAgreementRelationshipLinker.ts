import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement } from "@/db/schema";
import type { AgreementRelationshipLinker } from "./relationshipService";

/** Agreement connector (Phase 23): the sole writer of `agreement.relationship_id` — see AgreementRelationshipLinker's own doc comment in relationshipService.ts for why this is a narrow direct write rather than a new AgreementService method. */
export class DrizzleAgreementRelationshipLinker implements AgreementRelationshipLinker {
  async linkRelationship(agreementId: string, relationshipId: string): Promise<void> {
    const db = getDb();
    await db.update(agreement).set({ relationshipId }).where(eq(agreement.id, agreementId));
  }
}
