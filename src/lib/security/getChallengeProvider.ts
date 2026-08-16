import "server-only";
import { NoopChallengeProvider, type ChallengeProvider } from "./challengeProvider";

let cached: ChallengeProvider | null = null;

/** The only ChallengeProvider wired up in this codebase — a no-op, per this module's own doc comment. A real provider (Sprint TBD) would get its own concrete class and a runtime switch here driven by configuration, without any call site change. */
export function getChallengeProvider(): ChallengeProvider {
  if (!cached) cached = new NoopChallengeProvider();
  return cached;
}
