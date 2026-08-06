import { afterEach, describe, expect, it } from "vitest";
import { isFeatureEnabled } from "./feature-flags";

const OVERRIDE_KEY = "FEATURE_EXAMPLE_FOUNDATION_FLAG";

describe("isFeatureEnabled", () => {
  afterEach(() => {
    delete process.env[OVERRIDE_KEY];
  });

  it("returns the hard-coded default when no override is set", () => {
    expect(isFeatureEnabled("exampleFoundationFlag")).toBe(false);
  });

  it("returns true when the env override is the string 'true'", () => {
    process.env[OVERRIDE_KEY] = "true";
    expect(isFeatureEnabled("exampleFoundationFlag")).toBe(true);
  });

  it("returns false when the env override is the string 'false'", () => {
    process.env[OVERRIDE_KEY] = "false";
    expect(isFeatureEnabled("exampleFoundationFlag")).toBe(false);
  });

  it("falls back to the default for any other override value", () => {
    process.env[OVERRIDE_KEY] = "yes-please";
    expect(isFeatureEnabled("exampleFoundationFlag")).toBe(false);
  });
});
