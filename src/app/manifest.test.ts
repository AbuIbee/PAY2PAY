import { describe, expect, it } from "vitest";
import manifest from "./manifest";

describe("PWA manifest (B0-A: branding)", () => {
  it("uses the current Paid2You brand, not the stale PAY2PAY name", () => {
    const result = manifest();
    expect(result.name).toBe("Paid2You");
    expect(result.short_name).toBe("Paid2You");
  });
});
