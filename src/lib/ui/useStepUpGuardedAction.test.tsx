import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./apiFetch";
import { useStepUpGuardedAction } from "./useStepUpGuardedAction";

function stepUpError() {
  return new ApiError({ status: "error", code: "STEP_UP_REQUIRED", message: "Step-up verification is required." }, 403);
}

describe("useStepUpGuardedAction", () => {
  it("resolves directly when the wrapped action succeeds without a step-up challenge", async () => {
    const action = vi.fn(async (...args: unknown[]): Promise<string> => {
      void args;
      return "ok";
    });
    const { result } = renderHook(() => useStepUpGuardedAction(action));

    let resolved: string | undefined;
    await act(async () => {
      resolved = await result.current.run("arg-1");
    });

    expect(resolved).toBe("ok");
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith("arg-1");
    expect(result.current.isChallengeOpen).toBe(false);
  });

  it("opens a challenge on STEP_UP_REQUIRED, then retries the original call with the same args on resolveChallenge", async () => {
    const action = vi
      .fn(async (...args: unknown[]): Promise<string> => {
        void args;
        return "retried-ok";
      })
      .mockRejectedValueOnce(stepUpError());
    const { result } = renderHook(() => useStepUpGuardedAction(action));

    let runPromise: Promise<string> | undefined;
    act(() => {
      runPromise = result.current.run("agreement-42");
    });

    await waitFor(() => expect(result.current.isChallengeOpen).toBe(true));
    expect(action).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.resolveChallenge();
    });

    const resolved = await runPromise;
    expect(resolved).toBe("retried-ok");
    expect(action).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenNthCalledWith(2, "agreement-42");
    expect(result.current.isChallengeOpen).toBe(false);
  });

  it("rejects the original call when the challenge is cancelled", async () => {
    const action = vi.fn().mockRejectedValueOnce(stepUpError());
    const { result } = renderHook(() => useStepUpGuardedAction(action));

    let runPromise: Promise<unknown> | undefined;
    act(() => {
      runPromise = result.current.run();
    });
    await waitFor(() => expect(result.current.isChallengeOpen).toBe(true));

    act(() => {
      result.current.cancelChallenge();
    });

    await expect(runPromise).rejects.toThrow(/cancelled/i);
    expect(result.current.isChallengeOpen).toBe(false);
  });

  it("propagates a non-step-up error without opening a challenge", async () => {
    const action = vi.fn().mockRejectedValue(new Error("something else went wrong"));
    const { result } = renderHook(() => useStepUpGuardedAction(action));

    await expect(result.current.run()).rejects.toThrow("something else went wrong");
    expect(result.current.isChallengeOpen).toBe(false);
  });
});
