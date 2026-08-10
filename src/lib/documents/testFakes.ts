import type { ProfileKind } from "@/lib/profiles/verificationService";
import type { DocumentStorage } from "./documentStorage";
import type { ProfileDisplayReader } from "./profileDisplayReader";

export class InMemoryProfileDisplayReader implements ProfileDisplayReader {
  names = new Map<string, string>(); // `${kind}:${id}` -> name

  set(profileKind: ProfileKind, profileId: string, name: string): void {
    this.names.set(`${profileKind}:${profileId}`, name);
  }

  async getDisplayName(profileKind: ProfileKind, profileId: string): Promise<string> {
    return this.names.get(`${profileKind}:${profileId}`) ?? (profileKind === "personal" ? "Personal profile" : "Business profile");
  }
}

/**
 * Test-only in-memory double for DocumentStorage, mirroring every other external-provider fake in
 * this project (InMemorySmsSender, etc.). Real Supabase Storage is not exercised in this test
 * suite — no live Supabase Storage credentials are configured in this environment (see
 * SupabaseDocumentStorage's doc comment); this fake validates the storage *contract* (upload once,
 * never overwrite, signed URLs expire, unknown paths fail) that SignatureService depends on.
 */
export class InMemoryDocumentStorage implements DocumentStorage {
  private files = new Map<string, { content: Uint8Array; contentType: string }>();
  signedUrlsIssued: { path: string; expiresInSeconds: number }[] = [];

  async uploadPrivate(input: { path: string; content: Uint8Array; contentType: string }): Promise<void> {
    if (this.files.has(input.path)) {
      throw new Error(`Refusing to overwrite an already-stored immutable document at ${input.path}.`);
    }
    this.files.set(input.path, { content: input.content, contentType: input.contentType });
  }

  async createSignedUrl(path: string, expiresInSeconds: number): Promise<string> {
    if (!this.files.has(path)) {
      throw new Error(`No document stored at ${path}.`);
    }
    this.signedUrlsIssued.push({ path, expiresInSeconds });
    return `https://test-storage.local/signed/${encodeURIComponent(path)}?expires=${expiresInSeconds}`;
  }

  /** Test-only helper: read back stored bytes to verify round-trip hash stability. */
  read(path: string): Uint8Array | undefined {
    return this.files.get(path)?.content;
  }
}
