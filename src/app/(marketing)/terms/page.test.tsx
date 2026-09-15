import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TermsPage, { metadata } from "./page";

/**
 * B0-C (Privacy Policy + Terms of Service — contract freeze + implementation): dedicated coverage
 * for the frozen content contract's own required Terms of Service propositions (task's own numbered
 * list, items 25-48). Deliberately NOT a fragile full-document snapshot test — see privacy/page.test.tsx's
 * own identical doc-comment rationale.
 */
function renderBody(): string {
  render(<TermsPage />);
  return document.body.textContent ?? "";
}

describe("TermsPage (B0-C frozen contract)", () => {
  it("25: states Paid2You's platform role — technology for administering payment arrangements between the parties", () => {
    expect(renderBody()).toMatch(/provides technology that lets participating parties create, review, sign, administer, document, and service payment arrangements/i);
  });

  it("26: states 18+ age eligibility", () => {
    expect(renderBody()).toContain("18 years or older");
  });

  it("27: states the no-interest arrangement rule", () => {
    const body = renderBody();
    expect(body).toMatch(/intended for repayment arrangements without interest/i);
    expect(body).toMatch(/may not use Paid2You's arrangement functionality to impose or collect interest/i);
  });

  it("28: Paid2You is never described as a lender, and never claims to make loans or extend credit", () => {
    const body = renderBody();
    expect(body).not.toMatch(/\blender\b/i);
    expect(body).toMatch(/does not make loans or extend credit to users/i);
  });

  it("29: no repayment/counterparty-performance guarantee", () => {
    const body = renderBody();
    expect(body).toMatch(/does not guarantee that a counterparty to an arrangement will perform/i);
    expect(body).not.toMatch(/guarantees? repayment/i);
  });

  it("30: states a payments/provider caveat — settlement timing/availability of funds not guaranteed", () => {
    expect(renderBody()).toMatch(/does not guarantee the timing of settlement or the availability of funds/i);
  });

  it("31: distinguishes Paid2You's own platform fees from third-party processing fees", () => {
    const body = renderBody();
    expect(body).toMatch(/Paid2You may charge platform or service fees/i);
    expect(body).toMatch(/third-party payment provider may charge its own transaction or payment-processing fees/i);
    expect(body).toMatch(/processor fees are separate from.*Paid2You platform fee/i);
  });

  it("32: SMS program is described as transactional, never marketing/promotional", () => {
    const body = renderBody();
    expect(body).toMatch(/transactional\/service messages/i);
    expect(body).toMatch(/does not authorize marketing or promotional text messages/i);
  });

  it("33: states variable message frequency", () => {
    expect(renderBody()).toMatch(/message frequency varies based on account activity/i);
  });

  it("34: states message and data rates may apply", () => {
    expect(renderBody()).toContain("Message and data rates may apply");
  });

  it("35: mentions replying STOP", () => {
    expect(renderBody()).toMatch(/\bSTOP\b/);
  });

  it("36: mentions replying HELP", () => {
    expect(renderBody()).toMatch(/\bHELP\b/);
  });

  it("37: states SMS consent is optional / not required to use Paid2You", () => {
    expect(renderBody()).toMatch(/consent is not required to use Paid2You/i);
  });

  it("38: states the verified-phone / re-consent principle", () => {
    expect(renderBody()).toMatch(/consent applies to the verified phone number associated with your opt-in/i);
    expect(renderBody()).toMatch(/changing your verified phone number may require new, fresh consent/i);
  });

  it("39: distinguishes one-time MFA/security codes from the transactional SMS program, without rewriting MFA", () => {
    const body = renderBody();
    expect(body).toMatch(/one-time authentication or security code/i);
    expect(body).toMatch(/separate basis from the optional, ongoing transactional SMS program/i);
  });

  it("40: never claims SMS-keyword opt-in", () => {
    const body = renderBody();
    expect(body).toMatch(/you do not opt in by sending a text message containing a keyword/i);
    expect(body).not.toMatch(/text (the word |)(START|JOIN|YES) to/i);
  });

  it("41: never authorizes marketing SMS", () => {
    const body = renderBody();
    expect(body).not.toMatch(/marketing text messages? (are|is|may be) sent/i);
    expect(body).not.toMatch(/promotional text messages? (are|is|may be) sent/i);
  });

  it("42: contains no arbitration clause/obligation", () => {
    const body = renderBody();
    expect(body).not.toMatch(/you (must|agree to) (submit|resolve|settle).{0,40}arbitrat/i);
    expect(body).not.toMatch(/binding arbitration/i);
    expect(body).not.toMatch(/waive.{0,20}right to (a )?jury/i);
  });

  it("43: contains no class-action waiver", () => {
    const body = renderBody();
    expect(body).not.toMatch(/class[- ]action waiver/i);
    expect(body).not.toMatch(/waive.{0,20}class action/i);
  });

  it("44: does not invent a governing-law jurisdiction/state", () => {
    const body = renderBody();
    expect(body).not.toMatch(/governed by the laws of/i);
    expect(body).not.toMatch(/\b(Delaware|North Carolina|New York|California)\b.{0,20}(law|jurisdiction)/i);
    expect(body).toMatch(/do not currently designate a governing law/i);
  });

  it("45: no fabricated support email/phone/address is rendered", () => {
    expect(renderBody()).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  });

  it("46: links to the Privacy Policy (/privacy)", () => {
    render(<TermsPage />);
    expect(document.querySelector('a[href="/privacy"]')).toBeTruthy();
  });

  it("47: links to the Support route (/support) as the contact mechanism", () => {
    render(<TermsPage />);
    expect(document.querySelector('a[href="/support"]')).toBeTruthy();
  });

  it("48: page metadata uses a title that combines with the site-wide template to read '... | Paid2You', never PAY2PAY", () => {
    expect(metadata.title).toBe("Terms of Service");
    expect(String(metadata.title)).not.toContain("PAY2PAY");
  });

  it("no invented regulatory status, certification, or guaranteed-outcome language appears", () => {
    const body = renderBody();
    expect(body).not.toMatch(/FDIC|SOC ?2|PCI|HIPAA|GDPR|CCPA/);
    expect(body).not.toMatch(/bank-grade|military-grade/i);
    expect(body).not.toMatch(/guarantees? (payment|settlement|identity verification|availability)/i);
  });

  it("does not render the retired placeholder banner", () => {
    const body = renderBody();
    expect(body).not.toMatch(/this page is a placeholder/i);
    expect(body).not.toMatch(/not yet finalized/i);
    expect(body).not.toMatch(/pre-launch testing/i);
  });

  it("no stale PAY2PAY (all-caps) public branding remains", () => {
    expect(renderBody()).not.toMatch(/\bPAY2PAY\b/);
  });
});
