import { describe, expect, it } from "vitest";
import { metadata } from "./layout";

describe("Root layout metadata (B0-A: branding)", () => {
  it("uses the current Paid2You brand in the site-wide title, not the stale PAY2PAY name", () => {
    const title = metadata.title as { default: string; template: string };
    expect(title.default).toContain("Paid2You");
    expect(title.default).not.toContain("PAY2PAY");
    expect(title.template).toContain("Paid2You");
    expect(title.template).not.toContain("PAY2PAY");
  });
});
