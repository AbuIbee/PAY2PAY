import "server-only";
import { DrizzlePersonalProfileRepository } from "@/lib/auth/drizzlePersonalProfileRepository";
import { DrizzleBusinessProfileRepository } from "./drizzleBusinessProfileRepository";
import { ProfileAccessService } from "./profileAccessService";

let cached: ProfileAccessService | null = null;

export function getProfileAccessService(): ProfileAccessService {
  if (!cached) {
    cached = new ProfileAccessService(new DrizzlePersonalProfileRepository(), new DrizzleBusinessProfileRepository());
  }
  return cached;
}
