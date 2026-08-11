import "server-only";
import type { DocumentStorage } from "@/lib/documents/documentStorage";
import { SupabaseDocumentStorage } from "@/lib/documents/supabaseDocumentStorage";

/** Private bucket only — separate from AGREEMENT_PDF_BUCKET, per this sprint's own evidence documents. */
export const EVIDENCE_BUCKET = "agreement-evidence";

let cached: DocumentStorage | null = null;

/** Lazily creates (and memoizes) the production evidence DocumentStorage. Mirrors getDocumentStorage.ts's pattern. */
export function getEvidenceStorage(): DocumentStorage {
  if (!cached) {
    cached = new SupabaseDocumentStorage(EVIDENCE_BUCKET);
  }
  return cached;
}
