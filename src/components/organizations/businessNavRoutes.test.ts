import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUSINESS_NAV_ITEMS } from "@/components/AppNav";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Step 6/12: "Create corresponding routes so enabling
 * the feature flag does NOT produce dead links." This test is the structural proof that every href
 * AppNav's Business navigation can render resolves to an implemented page under
 * organizations/[organizationId] — never a dead link, flag on or off.
 */
describe("Business navigation routes", () => {
  const organizationRoot = path.join(process.cwd(), "src", "app", "(app)", "organizations", "[organizationId]");

  it.each(BUSINESS_NAV_ITEMS)("the %o nav item has an implemented page.tsx", ({ path: navPath, label }) => {
    const pageFile = navPath === "" ? path.join(organizationRoot, "page.tsx") : path.join(organizationRoot, ...navPath.split("/").filter(Boolean), "page.tsx");
    expect(existsSync(pageFile), `Expected a page.tsx for Business nav item "${label}" (${navPath || "/"}) at ${pageFile}`).toBe(true);
  });

  it("the organization route shell layout exists", () => {
    expect(existsSync(path.join(organizationRoot, "layout.tsx"))).toBe(true);
  });
});
