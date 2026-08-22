import "server-only";
import { DrizzleBetaInviteRepository } from "./drizzleBetaInviteRepository";
import { BetaInviteService } from "./betaInviteService";

let cached: BetaInviteService | null = null;

export function getBetaInviteService(): BetaInviteService {
  if (!cached) {
    cached = new BetaInviteService({ invites: new DrizzleBetaInviteRepository() });
  }
  return cached;
}
