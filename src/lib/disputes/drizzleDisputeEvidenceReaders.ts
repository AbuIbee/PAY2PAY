import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { achMandate, agreement, debitCardMethod, identityVerificationRecord, signatureEvent } from "@/db/schema";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import type { PaymentMethod } from "@/lib/payments/paymentService";
import type { IdentityVerificationReferenceReader, MandateReferenceReader, SignatureReferenceReader } from "./paymentDisputeService";

/** Sprint 16: "preserve mandate" — the most recent ach_mandate/debit_card_method row for this agreement, regardless of its current status (a claim must preserve what authorized this specific payment, even if since revoked/replaced). */
export class DrizzleMandateReferenceReader implements MandateReferenceReader {
  async findActiveReference(agreementId: string, paymentMethod: PaymentMethod | null): Promise<string | null> {
    const db = getDb();
    if (paymentMethod === "ach") {
      const rows = await db.select().from(achMandate).where(eq(achMandate.agreementId, agreementId)).orderBy(desc(achMandate.createdAt)).limit(1);
      return rows[0]?.id ?? null;
    }
    if (paymentMethod === "debit_card") {
      const rows = await db
        .select()
        .from(debitCardMethod)
        .where(eq(debitCardMethod.agreementId, agreementId))
        .orderBy(desc(debitCardMethod.createdAt))
        .limit(1);
      return rows[0]?.id ?? null;
    }
    return null;
  }
}

/** Sprint 16: "preserve signatures" — the claiming payer's own signature_event for the agreement's current version. */
export class DrizzleSignatureReferenceReader implements SignatureReferenceReader {
  async findReference(agreementId: string, payerProfileKind: ProfileKind, payerProfileId: string): Promise<string | null> {
    const db = getDb();
    const agreementRows = await db.select().from(agreement).where(eq(agreement.id, agreementId)).limit(1);
    const currentVersionId = agreementRows[0]?.currentVersionId;
    if (!currentVersionId) return null;

    const rows = await db
      .select()
      .from(signatureEvent)
      .where(
        and(
          eq(signatureEvent.agreementVersionId, currentVersionId),
          eq(signatureEvent.signerProfileKind, payerProfileKind),
          eq(signatureEvent.signerProfileId, payerProfileId),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }
}

/** Sprint 16: "preserve identity verification reference" — the most recent verified record, falling back to the most recent record of any status if none was ever verified. */
export class DrizzleIdentityVerificationReferenceReader implements IdentityVerificationReferenceReader {
  async findReference(profileKind: ProfileKind, profileId: string): Promise<string | null> {
    const db = getDb();
    const verified = await db
      .select()
      .from(identityVerificationRecord)
      .where(
        and(
          eq(identityVerificationRecord.profileKind, profileKind),
          eq(identityVerificationRecord.profileId, profileId),
          eq(identityVerificationRecord.status, "verified"),
        ),
      )
      .orderBy(desc(identityVerificationRecord.decidedAt))
      .limit(1);
    if (verified[0]) return verified[0].id;

    const any = await db
      .select()
      .from(identityVerificationRecord)
      .where(and(eq(identityVerificationRecord.profileKind, profileKind), eq(identityVerificationRecord.profileId, profileId)))
      .orderBy(desc(identityVerificationRecord.createdAt))
      .limit(1);
    return any[0]?.id ?? null;
  }
}
