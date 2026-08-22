import { describe, expect, it } from "vitest";
import { runDeepHealthCheck } from "./deepHealthCheck";

/**
 * No live database is configured in the test environment, so `database` is expected to report
 * "unreachable" here — this test proves the failure path degrades to a safe enum rather than
 * throwing or leaking a raw driver/connection-string error, not that a database happens to be up.
 */
describe("runDeepHealthCheck", () => {
  it("never throws, and never includes a raw error/secret value in its report", async () => {
    const report = await runDeepHealthCheck();
    expect(["ok", "unreachable", "misconfigured"]).toContain(report.database);
    expect(["ok", "unreachable", "misconfigured"]).toContain(report.environmentConfiguration);
    expect(report.checkedAt).toBeTruthy();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/postgres(ql)?:\/\//i);
    expect(serialized.toLowerCase()).not.toContain("password");
  });
});
