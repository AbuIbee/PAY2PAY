import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PrivacyPage, { metadata } from "./page";

/**
 * B0-C (Privacy Policy + Terms of Service — contract freeze + implementation): dedicated coverage
 * for the frozen content contract's own required Privacy Policy propositions (task's own numbered
 * list, items 1-24). Deliberately NOT a fragile full-document snapshot test — each test asserts one
 * contractual proposition, so future wording tweaks that preserve the underlying commitment don't
 * break these tests, per this pass's own explicit instruction.
 */
function renderBody(): string {
  render(<PrivacyPage />);
  return document.body.textContent ?? "";
}

describe("PrivacyPage (B0-C frozen contract)", () => {
  it("1: identifies Paid2You as the product/service this policy covers", () => {
    const body = renderBody();
    expect(body).toContain("Paid2You");
  });

  it("2: renders its full content synchronously with no authentication/session dependency (a server component with no client-side gate)", () => {
    // PrivacyPage is a plain server component — rendering it performs no fetch/session check at all,
    // unlike PublicSupport.tsx's own deliberate "render immediately, don't gate on auth" pattern for
    // /support. Asserting the full required content is present on the very first render is itself the
    // proof that nothing here is waiting on an authentication result.
    const body = renderBody();
    expect(body.length).toBeGreaterThan(500);
  });

  it("3: states an Effective Date", () => {
    expect(renderBody()).toContain("Effective Date: September 15, 2026");
  });

  it("4: states a Last Updated date", () => {
    expect(renderBody()).toContain("Last Updated: September 15, 2026");
  });

  it("5: contains the mandatory mobile-number/SMS non-sharing statement", () => {
    expect(renderBody()).toMatch(
      /does not sell, rent, or share your mobile phone number or SMS opt-in\/consent information with third parties or affiliates for their marketing or promotional purposes/i,
    );
  });

  it("6: separately states Paid2You does not sell/share personal information generally for third-party marketing", () => {
    expect(renderBody()).toMatch(/does not sell your information, and does not share your personal information with third parties or affiliates/i);
  });

  it("7: states message frequency varies based on account activity", () => {
    expect(renderBody()).toMatch(/message frequency varies based on account activity/i);
  });

  it('8: states "Message and data rates may apply"', () => {
    expect(renderBody()).toContain("Message and data rates may apply");
  });

  it("9: mentions replying STOP", () => {
    expect(renderBody()).toMatch(/\bSTOP\b/);
  });

  it("10: mentions replying HELP", () => {
    expect(renderBody()).toMatch(/\bHELP\b/);
  });

  it("11: states SMS consent is not required to use Paid2You", () => {
    expect(renderBody()).toMatch(/consent is not required to use Paid2You/i);
  });

  it("12: characterizes the SMS program as transactional, not marketing/promotional", () => {
    const body = renderBody();
    expect(body).toMatch(/transactional/i);
    expect(body).not.toMatch(/marketing text messages? (are|is) sent|promotional text messages? (are|is) sent/i);
  });

  it("13: describes web/application opt-in and never an SMS-keyword opt-in", () => {
    const body = renderBody();
    expect(body).toMatch(/web\/application notification-preference control|web or application SMS preference control/i);
    expect(body).not.toMatch(/text (the word |)(START|JOIN|YES) to/i);
  });

  it("14: financial-data description never falsely claims Paid2You stores no financial information", () => {
    const body = renderBody();
    expect(body).not.toMatch(/we (do not|don't|never) store (any )?financial (information|data)/i);
    expect(body).not.toMatch(/does not store (any )?financial (information|data)/i);
    // The corrected, truthful framing must actually be present: a concrete, limited financial-account
    // metadata description, not a blanket "no financial data" denial.
    expect(body).toMatch(/provider-issued token or reference/i);
    expect(body).toMatch(/last four digits/i);
  });

  it("15: discloses reliance on service providers (generic, no named provider claimed live)", () => {
    const body = renderBody();
    expect(body).toMatch(/service providers?/i);
    expect(body).not.toMatch(/\bTwilio\b|\bStripe\b|\bPlaid\b|\bPersona\b|\bResend\b/);
  });

  it("16: discloses information sharing with the other party to an arrangement (counterparties)", () => {
    expect(renderBody()).toMatch(/available to the other participating party as necessary to present, review, sign, administer, document, or service that arrangement/i);
  });

  it("17: contains a data-retention section using conservative, non-specific-deletion-period language", () => {
    const body = renderBody();
    expect(body).toMatch(/retains information for as long as reasonably necessary/i);
    expect(body).not.toMatch(/deleted (immediately|within \d+ days)/i);
  });

  it("18: security language does not guarantee absolute security", () => {
    const body = renderBody();
    expect(body).toMatch(/no method of electronic storage or transmission can be guaranteed completely secure/i);
    expect(body).not.toMatch(/guarantee(s|d)? (complete|absolute|total) security/i);
  });

  it("19: directs privacy questions/requests to the /support route", () => {
    render(<PrivacyPage />);
    const link = document.querySelector('a[href="/support"]');
    expect(link).toBeTruthy();
  });

  it("20: no internal documentation path is rendered", () => {
    const body = renderBody();
    expect(body).not.toMatch(/docs\//);
    expect(body).not.toMatch(/COMPLIANCE_REVIEW_CHECKLIST/);
    expect(body).not.toMatch(/DATA_MODEL\.md/);
  });

  it("21: no localhost URL is rendered", () => {
    expect(renderBody()).not.toMatch(/localhost/i);
  });

  it("22: no vercel.app URL is rendered", () => {
    expect(renderBody()).not.toMatch(/vercel\.app/i);
  });

  it("23: no fabricated support@paid2you.com (or any) email address is rendered", () => {
    expect(renderBody()).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  });

  it("24: no stale PAY2PAY (all-caps) public branding remains", () => {
    expect(renderBody()).not.toMatch(/\bPAY2PAY\b/);
  });

  it("does not render the retired placeholder banner", () => {
    const body = renderBody();
    expect(body).not.toMatch(/this page is a placeholder/i);
    expect(body).not.toMatch(/not yet finalized/i);
    expect(body).not.toMatch(/pre-launch testing/i);
  });

  it("page metadata uses a title that combines with the site-wide template to read '... | Paid2You', never PAY2PAY", () => {
    expect(metadata.title).toBe("Privacy Policy");
    expect(String(metadata.title)).not.toContain("PAY2PAY");
  });
});
