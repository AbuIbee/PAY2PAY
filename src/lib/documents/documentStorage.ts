/**
 * Sprint 6 (docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md): "Store PDFs in Supabase
 * Storage using private buckets and authorized signed URLs. Never expose private buckets
 * publicly." This interface is the seam — SignatureService depends on it, never on the Supabase
 * client directly, so the storage abstraction pattern matches every other external-provider seam
 * already established in this project (payment-provider abstraction, SmsSender/EmailSender).
 */
export interface DocumentStorage {
  uploadPrivate(input: { path: string; content: Uint8Array; contentType: string }): Promise<void>;
  /** Never returns a public URL — always a time-limited, authorization-gated signed URL. */
  createSignedUrl(path: string, expiresInSeconds: number): Promise<string>;
}
