import type { ProfileKind } from "@/lib/profiles/verificationService";

export interface ProfileDisplayReader {
  /** Best-effort display name for a party's PDF/evidence record — never used for authorization. */
  getDisplayName(profileKind: ProfileKind, profileId: string): Promise<string>;
}
