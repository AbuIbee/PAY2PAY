import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBaseUrl } from "./smoke-test.mjs";

test("--url takes precedence over SMOKE_TEST_URL", () => {
  const result = resolveBaseUrl(["node", "smoke-test.mjs", "--url", "https://from-arg.example"], { SMOKE_TEST_URL: "https://from-env.example" });
  assert.equal(result, "https://from-arg.example");
});

test("falls back to SMOKE_TEST_URL when --url is not given", () => {
  const result = resolveBaseUrl(["node", "smoke-test.mjs"], { SMOKE_TEST_URL: "https://from-env.example" });
  assert.equal(result, "https://from-env.example");
});

test("strips a trailing slash so path-joining never double-slashes", () => {
  const result = resolveBaseUrl(["node", "smoke-test.mjs", "--url", "https://from-arg.example/"], {});
  assert.equal(result, "https://from-arg.example");
});

test("returns null when neither --url nor SMOKE_TEST_URL is provided", () => {
  const result = resolveBaseUrl(["node", "smoke-test.mjs"], {});
  assert.equal(result, null);
});
