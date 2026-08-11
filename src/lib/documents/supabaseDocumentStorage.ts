import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/config/env";
import { ConfigurationError } from "@/lib/errors";
import type { DocumentStorage } from "./documentStorage";

/** Private bucket only — this name must be created as a private (non-public) bucket in Supabase. */
export const AGREEMENT_PDF_BUCKET = "agreement-pdfs";

/**
 * Real Supabase Storage implementation. Lazily constructs the Supabase client on first use (not at
 * module load) so importing this module never fails just because SUPABASE_URL/
 * SUPABASE_SERVICE_ROLE_KEY aren't configured — only an actual storage operation does, with a clear
 * ConfigurationError, matching "Auth routes fail safely with no live database" from Phase 0.
 *
 * Uses the service-role key (server-only, never shipped to the client) so uploads/signed-URL
 * issuance work regardless of RLS policy on the bucket's object table — access control for *who
 * may ask this service to issue a signed URL* is enforced by SignatureService before this class is
 * ever called, not by Supabase Storage's own policies.
 */
export class SupabaseDocumentStorage implements DocumentStorage {
  private client: SupabaseClient | null = null;

  /**
   * Sprint 7 (docs/sprints/SPRINT_07_Evidence_Documents_Witnesses.md): bucket is now a constructor
   * parameter rather than the hard-coded `AGREEMENT_PDF_BUCKET` module constant, so this same class
   * can also back evidence-document storage in a *separate* private bucket without duplicating the
   * upload/signed-URL logic. `getDocumentStorage()` still passes `AGREEMENT_PDF_BUCKET` (unchanged
   * behavior for Sprint 6 callers); `getEvidenceStorage()` (src/lib/evidence/) passes a different
   * bucket name.
   */
  constructor(private readonly bucket: string) {}

  private getClient(): SupabaseClient {
    if (this.client) return this.client;
    const env = getServerEnv();
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new ConfigurationError(
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured to store or retrieve signed agreement PDFs.",
      );
    }
    this.client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    return this.client;
  }

  async uploadPrivate(input: { path: string; content: Uint8Array; contentType: string }): Promise<void> {
    const client = this.getClient();
    const { error } = await client.storage.from(this.bucket).upload(input.path, input.content, {
      contentType: input.contentType,
      upsert: false, // immutable — never overwrite an already-stored document
    });
    if (error) {
      throw new ConfigurationError(`Failed to store the agreement PDF: ${error.message}`, error);
    }
  }

  async createSignedUrl(path: string, expiresInSeconds: number): Promise<string> {
    const client = this.getClient();
    const { data, error } = await client.storage.from(this.bucket).createSignedUrl(path, expiresInSeconds);
    if (error || !data?.signedUrl) {
      throw new ConfigurationError(`Failed to create a signed URL for the agreement PDF: ${error?.message ?? "unknown error"}`, error);
    }
    return data.signedUrl;
  }
}
