import { describe, expect, it } from "vitest";
import { createPerKeyProviderCallCounter } from "./perKeyProviderCallCounter";

describe("createPerKeyProviderCallCounter — STAGE 2 PHASE C TEST-FAILURE REMEDIATION (TEST 008-I correction)", () => {
  it("record() returns an independent, per-key running count — the first call for a key returns 1, the second returns 2", () => {
    const counter = createPerKeyProviderCallCounter();
    expect(counter.record("retry-a")).toBe(1);
    expect(counter.record("retry-a")).toBe(2);
  });

  it("countFor() reflects the exact number of times record() was called for that key, without calling record() itself", () => {
    const counter = createPerKeyProviderCallCounter();
    counter.record("retry-a");
    counter.record("retry-a");
    counter.record("retry-a");
    expect(counter.countFor("retry-a")).toBe(3);
  });

  it("countFor() returns 0 for a key that has never been recorded", () => {
    const counter = createPerKeyProviderCallCounter();
    expect(counter.countFor("never-called")).toBe(0);
  });

  it("an UNRELATED key's invocations do not affect the target key's count — the exact property TEST 008-I's own fix depends on", () => {
    const counter = createPerKeyProviderCallCounter();
    const targetKey = "retry-target-abc";
    counter.record(targetKey);
    // An unrelated retry, incidentally swept up by the same scheduler call, calls the provider double
    // multiple times in between the target's own calls.
    counter.record("retry-unrelated-1");
    counter.record("retry-unrelated-1");
    counter.record("retry-unrelated-2");
    expect(counter.countFor(targetKey)).toBe(1); // completely unaffected by the 3 unrelated calls.
    counter.record(targetKey);
    expect(counter.countFor(targetKey)).toBe(2); // the target's own second call still counts correctly.
  });

  it("a DUPLICATE invocation for the target key is still detected — the counter never deduplicates or caps a repeated key", () => {
    const counter = createPerKeyProviderCallCounter();
    const targetKey = "retry-target-xyz";
    counter.record(targetKey);
    counter.record(targetKey);
    counter.record(targetKey);
    expect(counter.countFor(targetKey)).toBe(3);
  });

  it("keys() lists every distinct key ever recorded, including unrelated ones — unrelated calls are never silently invisible", () => {
    const counter = createPerKeyProviderCallCounter();
    counter.record("retry-target");
    counter.record("retry-unrelated-1");
    counter.record("retry-unrelated-1");
    counter.record("retry-unrelated-2");
    expect(counter.keys().sort()).toEqual(["retry-target", "retry-unrelated-1", "retry-unrelated-2"]);
  });

  it("two independent counters never share state", () => {
    const counterA = createPerKeyProviderCallCounter();
    const counterB = createPerKeyProviderCallCounter();
    counterA.record("same-key");
    counterA.record("same-key");
    counterB.record("same-key");
    expect(counterA.countFor("same-key")).toBe(2);
    expect(counterB.countFor("same-key")).toBe(1);
  });
});
