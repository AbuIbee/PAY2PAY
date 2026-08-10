import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { signatureEvent } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { MfaMethod } from "@/lib/auth/mfaService";
import type { SignatureEventRecord, SignatureEventRepository } from "./signatureService";

type Row = typeof signatureEvent.$inferSelect;

function toRecord(row: Row): SignatureEventRecord {
  return {
    id: row.id,
    agreementVersionId: row.agreementVersionId,
    signerUserId: row.signerUserId,
    signerProfileKind: row.signerProfileKind,
    signerProfileId: row.signerProfileId,
    signerRole: row.signerRole,
    signingAuthority: row.signingAuthority,
    signerTitle: row.signerTitle,
    consentCaptured: row.consentCaptured,
    consentVersion: row.consentVersion,
    // "passkey" is reserved in the DB enum (src/db/schema/enums.ts) but not yet implemented
    // anywhere in this codebase's MFA flow — insert()'s input type already constrains writes to
    // MfaMethod ("totp"|"sms"), so this cast reflects a real invariant, not a loosened one.
    authMethod: row.authMethod as MfaMethod,
    ipAddress: row.ipAddress,
    deviceInfo: row.deviceInfo,
    timezone: row.timezone,
    agreementHashAtSigning: row.agreementHashAtSigning,
    signedAt: row.signedAt,
  };
}

export class DrizzleSignatureEventRepository implements SignatureEventRepository {
  async insert(input: Omit<SignatureEventRecord, "id" | "signedAt">): Promise<SignatureEventRecord> {
    const db = getDb();
    const [row] = await db
      .insert(signatureEvent)
      .values({ ...input, deviceInfo: input.deviceInfo as object | null })
      .returning();
    if (!row) throw new ConfigurationError("signature_event insert returned no row");
    return toRecord(row);
  }

  async listForVersion(agreementVersionId: string): Promise<SignatureEventRecord[]> {
    const db = getDb();
    const rows = await db.select().from(signatureEvent).where(eq(signatureEvent.agreementVersionId, agreementVersionId));
    return rows.map(toRecord);
  }
}
