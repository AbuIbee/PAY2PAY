import "server-only";
import { SupabaseDocumentStorage } from "./supabaseDocumentStorage";
import type { DocumentStorage } from "./documentStorage";

let cached: DocumentStorage | null = null;

/** Lazily creates (and memoizes) the production DocumentStorage. Mirrors getMfaService.ts's pattern. */
export function getDocumentStorage(): DocumentStorage {
  if (!cached) {
    cached = new SupabaseDocumentStorage();
  }
  return cached;
}
