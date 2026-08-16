import { describe, expect, it } from "vitest";
import { NoopChallengeProvider } from "./challengeProvider";
import { getChallengeProvider } from "./getChallengeProvider";

describe("NoopChallengeProvider", () => {
  it("always passes, regardless of input", async () => {
    const provider = new NoopChallengeProvider();
    const result = await provider.verify({ token: null, action: "login", ipAddress: "1.2.3.4" });
    expect(result.passed).toBe(true);
  });
});

describe("getChallengeProvider", () => {
  it("returns a NoopChallengeProvider — the only implementation wired up in this codebase today", async () => {
    const provider = getChallengeProvider();
    const result = await provider.verify({ token: "anything", action: "signup", ipAddress: "1.2.3.4" });
    expect(result.passed).toBe(true);
  });
});
