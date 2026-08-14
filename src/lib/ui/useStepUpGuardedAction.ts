"use client";

import { useCallback, useState } from "react";
import { isStepUpRequired } from "./apiFetch";

interface PendingChallenge<Args extends unknown[], R> {
  args: Args;
  resolve: (value: R) => void;
  reject: (reason: unknown) => void;
}

/**
 * Sprint 18B: generic wiring for "action -> backend says step-up required ->
 * UI challenge -> success -> safely retry original action" so every
 * sensitive-action component (sign, settlement accept, staff role change,
 * ...) gets this behavior without re-implementing it. `fn` should be a
 * thin wrapper around apiFetch for the actual mutating call.
 *
 * Usage:
 *   const { run, challenge, resolveChallenge, cancelChallenge } = useStepUpGuardedAction(signAgreement);
 *   await run(agreementId); // throws/resolves normally; on STEP_UP_REQUIRED, `challenge` becomes non-null
 *   // render <StepUpChallenge ... onVerified={resolveChallenge} onCancel={cancelChallenge} /> when challenge is set
 */
export function useStepUpGuardedAction<Args extends unknown[], R>(fn: (...args: Args) => Promise<R>) {
  const [challenge, setChallenge] = useState<PendingChallenge<Args, R> | null>(null);

  const run = useCallback(
    (...args: Args): Promise<R> => {
      return fn(...args).catch((error: unknown) => {
        if (isStepUpRequired(error)) {
          return new Promise<R>((resolve, reject) => {
            setChallenge({ args, resolve, reject });
          });
        }
        throw error;
      });
    },
    [fn],
  );

  const resolveChallenge = useCallback(() => {
    if (!challenge) return;
    const { args, resolve, reject } = challenge;
    setChallenge(null);
    void fn(...args).then(resolve, reject);
  }, [challenge, fn]);

  const cancelChallenge = useCallback(() => {
    if (!challenge) return;
    challenge.reject(new Error("Verification was cancelled."));
    setChallenge(null);
  }, [challenge]);

  return { run, isChallengeOpen: challenge !== null, resolveChallenge, cancelChallenge };
}
