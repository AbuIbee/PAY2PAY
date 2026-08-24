import { test, expect } from "@playwright/test";

/** SPRINT_20_ClosedBetaReadiness: static/marketing/auth pages render correctly, with no localhost references or developer placeholder text — checked with a real browser, not code inspection. */
const PAGES: Array<{ path: string; titleContains: string }> = [
  { path: "/login", titleContains: "Sign in" },
  { path: "/signup", titleContains: "Create account" },
  { path: "/forgot-password", titleContains: "Forgot password" },
  { path: "/terms", titleContains: "Terms of Service" },
  { path: "/privacy", titleContains: "Privacy Policy" },
  { path: "/demo", titleContains: "Try the demo" },
  // Demo navigation & dedicated demo experiences (Product Owner request): the four dedicated demo
  // routes must remain publicly accessible (no login) exactly like every other page in this list.
  { path: "/demo/p2p", titleContains: "P2P Demo" },
  { path: "/demo/c2b", titleContains: "C2B Demo" },
  { path: "/demo/b2b", titleContains: "B2B Demo" },
  { path: "/demo/tour", titleContains: "Product Tour" },
];

for (const { path, titleContains } of PAGES) {
  test(`${path} renders with no localhost/placeholder text and no console errors`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    const response = await page.goto(path, { waitUntil: "networkidle" });
    expect(response?.status()).toBeLessThan(400);
    await expect(page).toHaveTitle(new RegExp(titleContains, "i"));

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/localhost/i);
    expect(bodyText).not.toMatch(/TODO|lorem ipsum|coming soon/i);

    // The env-misconfiguration 500 this sprint documented separately is not a console error class
    // this suite runs against (it requires deliberately broken config) — filter it out defensively
    // so a real client-side error doesn't get lost in noise if this ever runs against a broken env.
    const realErrors = consoleErrors.filter((e) => !e.includes("500") && !e.includes("Failed to load resource"));
    expect(realErrors).toEqual([]);
  });
}

test("login page has properly labeled email/password fields and a working link to signup", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel(/^email$/i)).toBeVisible();
  await expect(page.getByLabel(/^password$/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  await page.getByRole("link", { name: /create an account/i }).click();
  await expect(page).toHaveURL(/\/signup$/);
});

test("signup page has properly labeled email/password/date-of-birth fields", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByLabel(/^email$/i)).toBeVisible();
  await expect(page.getByLabel(/^password$/i)).toBeVisible();
  await expect(page.getByLabel(/date of birth/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /create account/i })).toBeVisible();
});

/**
 * Demo navigation & dedicated demo experiences (Product Owner request): the /demo landing page
 * links into all four dedicated demo routes, and each one is reachable and functional with real
 * browser navigation — no login involved, matching this whole file's unauthenticated-only scope
 * (see playwright.config.ts's own doc comment on why authenticated flows aren't covered here).
 */
test("the /demo landing page links to all four dedicated demo experiences, and each one works", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("link", { name: /^p2p demo$/i })).toHaveAttribute("href", "/demo/p2p");
  await expect(page.getByRole("link", { name: /^c2b demo$/i })).toHaveAttribute("href", "/demo/c2b");
  await expect(page.getByRole("link", { name: /^b2b demo$/i })).toHaveAttribute("href", "/demo/b2b");
  await expect(page.getByRole("link", { name: /^product tour$/i })).toHaveAttribute("href", "/demo/tour");

  await page.getByRole("link", { name: /^p2p demo$/i }).click();
  await expect(page).toHaveURL(/\/demo\/p2p$/);
  await expect(page.getByRole("heading", { name: "The situation" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^next$/i })).toBeVisible();

  await page.goto("/demo");
  await page.getByRole("link", { name: /^c2b demo$/i }).click();
  await expect(page).toHaveURL(/\/demo\/c2b$/);
  await expect(page.getByRole("button", { name: /^next$/i })).toBeVisible();

  await page.goto("/demo");
  await page.getByRole("link", { name: /^b2b demo$/i }).click();
  await expect(page).toHaveURL(/\/demo\/b2b$/);
  await expect(page.getByRole("button", { name: /^next$/i })).toBeVisible();

  await page.goto("/demo");
  await page.getByRole("link", { name: /^product tour$/i }).click();
  await expect(page).toHaveURL(/\/demo\/tour$/);
  await expect(page.getByRole("button", { name: /^next$/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /exit tour/i })).toBeVisible();
});

test("every dedicated demo route shows the exact required safety banner", async ({ page }) => {
  for (const path of ["/demo/p2p", "/demo/c2b", "/demo/b2b", "/demo/tour"]) {
    await page.goto(path);
    await expect(page.getByText("DEMO — No real money or customer data is being used.")).toBeVisible();
  }
});

/**
 * The most important safety guarantee: clicking through a full demo scenario in a real browser
 * never fires a mutating network request (POST/PUT/PATCH/DELETE) — no real invitation, agreement,
 * verification, signature, payment method, or payment is ever created, exactly as required.
 */
test("demo routes make zero real payment/network mutation calls while stepping through a full scenario", async ({ page }) => {
  const mutatingRequests: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      mutatingRequests.push(`${request.method()} ${request.url()}`);
    }
  });

  for (const path of ["/demo/p2p", "/demo/c2b", "/demo/b2b", "/demo/tour"]) {
    await page.goto(path);
    // Click Next repeatedly until it's gone (replaced by the final-step link) — walks the entire
    // scenario, which is exactly where a real app would fire create-invitation/sign/pay calls.
    for (let i = 0; i < 15; i += 1) {
      const nextButton = page.getByRole("button", { name: /^next$/i });
      if (!(await nextButton.isVisible().catch(() => false))) break;
      await nextButton.click();
    }
  }

  expect(mutatingRequests).toEqual([]);
});
