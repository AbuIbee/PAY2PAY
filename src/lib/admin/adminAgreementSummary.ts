import "server-only";
import { inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreementPdf, agreementVersion } from "@/db/schema";
import type { AdminAgreementSummary } from "./adminService";

type AgreementRow = {
  id: string;
  status: string;
  creditorProfileKind: "personal" | "business";
  debtorProfileKind: "personal" | "business";
  currentVersionId: string | null;
};

function relationshipShape(row: Pick<AgreementRow, "creditorProfileKind" | "debtorProfileKind">): string {
  return row.creditorProfileKind === "personal" && row.debtorProfileKind === "personal"
    ? "P2P"
    : row.creditorProfileKind === "business" && row.debtorProfileKind === "personal"
      ? "B2C"
      : row.creditorProfileKind === "personal" && row.debtorProfileKind === "business"
        ? "C2B"
        : "B2B";
}

/**
 * PRSprint 12 (docs/prsprints/PRSPRINT_12_ELECTRONIC_SIGNATURES_PDFS_IMMUTABLE_RECORDS.md)
 * requirement #22: shared between DrizzleAdminUserDirectoryReader and
 * DrizzleAdminBusinessDirectoryReader so admin's read-only "which agreements does this user/business
 * have, and what's their signature/execution status" view is computed identically in both places —
 * two batched follow-up queries (never N+1) against `agreement_version`/`agreement_pdf`, read-only,
 * never through AgreementService/SignatureService.
 */
export async function summarizeAgreementsForAdmin(rows: AgreementRow[]): Promise<AdminAgreementSummary[]> {
  const versionIds = rows.map((r) => r.currentVersionId).filter((id): id is string => id !== null);
  if (versionIds.length === 0) {
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      relationshipShape: relationshipShape(row),
      currentVersionNumber: null,
      currentVersionSigned: false,
      hasExecutedPdf: false,
    }));
  }

  const db = getDb();
  const [versionRows, pdfRows] = await Promise.all([
    db
      .select({ id: agreementVersion.id, versionNumber: agreementVersion.versionNumber, signedAt: agreementVersion.signedAt })
      .from(agreementVersion)
      .where(inArray(agreementVersion.id, versionIds)),
    db.select({ agreementVersionId: agreementPdf.agreementVersionId }).from(agreementPdf).where(inArray(agreementPdf.agreementVersionId, versionIds)),
  ]);
  const versionsById = new Map(versionRows.map((v) => [v.id, v]));
  const versionIdsWithPdf = new Set(pdfRows.map((p) => p.agreementVersionId));

  return rows.map((row) => {
    const version = row.currentVersionId ? versionsById.get(row.currentVersionId) : undefined;
    return {
      id: row.id,
      status: row.status,
      relationshipShape: relationshipShape(row),
      currentVersionNumber: version?.versionNumber ?? null,
      currentVersionSigned: version?.signedAt != null,
      hasExecutedPdf: row.currentVersionId ? versionIdsWithPdf.has(row.currentVersionId) : false,
    };
  });
}
