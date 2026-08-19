import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, parsePageParams, toPage } from "./pagination";

describe("parsePageParams", () => {
  it("defaults to a safe limit/offset when no params are supplied", () => {
    expect(parsePageParams(new URLSearchParams())).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
  });

  it("honors a valid limit/offset within range", () => {
    expect(parsePageParams(new URLSearchParams("limit=10&offset=20"))).toEqual({ limit: 10, offset: 20 });
  });

  it("clamps a limit above the maximum instead of allowing an unbounded fetch", () => {
    expect(parsePageParams(new URLSearchParams("limit=99999"))).toEqual({ limit: MAX_PAGE_LIMIT, offset: 0 });
  });

  it("falls back to defaults for malformed/negative input rather than throwing", () => {
    expect(parsePageParams(new URLSearchParams("limit=not-a-number&offset=-5"))).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
  });
});

describe("toPage", () => {
  it("reports hasMore and trims the extra row when limit+1 rows were fetched", () => {
    const rows = [1, 2, 3];
    const page = toPage(rows, { limit: 2, offset: 0 });
    expect(page.items).toEqual([1, 2]);
    expect(page.hasMore).toBe(true);
  });

  it("reports hasMore=false when fewer than limit+1 rows exist", () => {
    const rows = [1, 2];
    const page = toPage(rows, { limit: 2, offset: 0 });
    expect(page.items).toEqual([1, 2]);
    expect(page.hasMore).toBe(false);
  });
});
