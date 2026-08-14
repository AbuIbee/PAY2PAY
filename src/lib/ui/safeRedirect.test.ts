import { describe, expect, it } from "vitest";
import { getSafeNextPath } from "./safeRedirect";

describe("getSafeNextPath", () => {
  it("returns the fallback when next is missing", () => {
    expect(getSafeNextPath(null, "/dashboard")).toBe("/dashboard");
  });

  it("honors a same-origin relative path", () => {
    expect(getSafeNextPath("/connections/accept?id=abc", "/dashboard")).toBe("/connections/accept?id=abc");
  });

  it("rejects a protocol-relative path (open-redirect vector)", () => {
    expect(getSafeNextPath("//evil.example", "/dashboard")).toBe("/dashboard");
  });

  it("rejects an absolute URL to another origin", () => {
    expect(getSafeNextPath("https://evil.example/phish", "/dashboard")).toBe("/dashboard");
  });

  it("rejects a path that doesn't start with a slash", () => {
    expect(getSafeNextPath("evil.example", "/dashboard")).toBe("/dashboard");
  });
});
