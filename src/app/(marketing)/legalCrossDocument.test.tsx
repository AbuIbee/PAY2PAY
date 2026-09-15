import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PrivacyPage from "./privacy/page";
import TermsPage from "./terms/page";

/**
 * B0-C (Privacy Policy + Terms of Service — contract freeze + implementation): the frozen contract's
 * own "CROSS-DOCUMENT CONSISTENCY — MANDATORY" section, items 49-53. Both pages import several shared
 * constants (`src/lib/legal/legalMeta.ts`) and the same `SMS_CONSENT_DISCLOSURE_TEXT` B0-B's live
 * consent UI already uses, so most of this is structurally guaranteed rather than merely tested — but
 * these tests independently verify the actual rendered output agrees, rather than trusting the shared
 * import alone.
 */
function bodyOf(node: React.ReactElement): string {
  render(node);
  return document.body.textContent ?? "";
}

describe("Privacy Policy / Terms of Service — cross-document consistency", () => {
  it("49: SMS language is materially consistent (identical disclosure text, STOP/HELP, frequency, rates, consent-optional, phone-binding concept)", () => {
    const privacy = bodyOf(<PrivacyPage />);
    const terms = bodyOf(<TermsPage />);
    for (const body of [privacy, terms]) {
      expect(body).toMatch(/message frequency varies based on account activity/i);
      expect(body).toContain("Message and data rates may apply");
      expect(body).toMatch(/\bSTOP\b/);
      expect(body).toMatch(/\bHELP\b/);
      expect(body).toMatch(/consent is not required to use Paid2You/i);
      expect(body).toMatch(/verified phone number/i);
    }
  });

  it("50: age eligibility (18 years or older) is consistent", () => {
    const privacy = bodyOf(<PrivacyPage />);
    const terms = bodyOf(<TermsPage />);
    expect(privacy).toContain("18 years or older");
    expect(terms).toContain("18 years or older");
  });

  it("51: product/platform role is consistent — a technology platform for payment arrangements between the parties, never a lender", () => {
    const privacy = bodyOf(<PrivacyPage />);
    const terms = bodyOf(<TermsPage />);
    expect(privacy).toMatch(/technology platform that helps people create, review, sign, administer, document, and service payment arrangements/i);
    expect(terms).toMatch(/provides technology that lets participating parties create, review, sign, administer, document, and service payment arrangements/i);
    expect(privacy).not.toMatch(/\blender\b/i);
    expect(terms).not.toMatch(/\blender\b/i);
  });

  it("52: the support route (/support) is the consistent contact mechanism in both documents", () => {
    render(<PrivacyPage />);
    expect(document.querySelector('a[href="/support"]')).toBeTruthy();
    document.body.innerHTML = "";
    render(<TermsPage />);
    expect(document.querySelector('a[href="/support"]')).toBeTruthy();
  });

  it("53: public brand is consistent — both documents use Paid2You exclusively, never PAY2PAY", () => {
    const privacy = bodyOf(<PrivacyPage />);
    const terms = bodyOf(<TermsPage />);
    expect(privacy).toContain("Paid2You");
    expect(terms).toContain("Paid2You");
    expect(privacy).not.toMatch(/\bPAY2PAY\b/);
    expect(terms).not.toMatch(/\bPAY2PAY\b/);
  });

  it("opt-in method wording is consistent — web/application control, never an SMS keyword, in both documents", () => {
    const privacy = bodyOf(<PrivacyPage />);
    const terms = bodyOf(<TermsPage />);
    expect(privacy).toMatch(/web or application SMS preference control/i);
    expect(terms).toMatch(/web or application SMS preference control/i);
    expect(privacy).not.toMatch(/text (the word |)(START|JOIN|YES) to/i);
    expect(terms).not.toMatch(/text (the word |)(START|JOIN|YES) to/i);
  });

  it("neither document contradicts the other on financial-data storage (both describe limited metadata, neither claims 'no financial data')", () => {
    const privacy = bodyOf(<PrivacyPage />);
    const terms = bodyOf(<TermsPage />);
    expect(privacy).not.toMatch(/does not store (any )?financial (information|data)/i);
    expect(terms).not.toMatch(/does not store (any )?financial (information|data)/i);
  });

  it("neither document authorizes marketing/promotional SMS", () => {
    const privacy = bodyOf(<PrivacyPage />);
    const terms = bodyOf(<TermsPage />);
    expect(privacy).not.toMatch(/marketing text messages? (are|is|may be) sent/i);
    expect(terms).not.toMatch(/marketing text messages? (are|is|may be) sent/i);
  });
});
