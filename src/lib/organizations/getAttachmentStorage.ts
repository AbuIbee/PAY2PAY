import "server-only";
import type { DocumentStorage } from "@/lib/documents/documentStorage";
import { SupabaseDocumentStorage } from "@/lib/documents/supabaseDocumentStorage";

/** Private bucket only — separate from AGREEMENT_PDF_BUCKET/EVIDENCE_BUCKET, per this feature's own organization-scoped documents. */
export const ATTACHMENT_BUCKET = "organization-documents";

let cached: DocumentStorage | null = null;

/** Lazily creates (and memoizes) the production Business Attachments DocumentStorage. Mirrors getEvidenceStorage.ts's pattern. */
export function getAttachmentStorage(): DocumentStorage {
  if (!cached) {
    cached = new SupabaseDocumentStorage(ATTACHMENT_BUCKET);
  }
  return cached;
}
