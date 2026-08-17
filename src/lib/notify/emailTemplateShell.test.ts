import { describe, expect, it } from "vitest";
import { escapeHtml, renderBrandedEmail, sanitizeSingleLine } from "./emailTemplateShell";

describe("escapeHtml", () => {
  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert('x')&"y"</script>`)).toBe("&lt;script&gt;alert(&#39;x&#39;)&amp;&quot;y&quot;&lt;/script&gt;");
  });
});

describe("sanitizeSingleLine", () => {
  it("strips CR/LF and collapses them to a space", () => {
    expect(sanitizeSingleLine("Hello\r\nBcc: attacker@evil.com")).toBe("Hello Bcc: attacker@evil.com");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeSingleLine("  padded  ")).toBe("padded");
  });
});

describe("renderBrandedEmail", () => {
  it("produces both html and text, with the plain body preserved in text", () => {
    const result = renderBrandedEmail({ subject: "Hello", body: "Line one.\n\nLine two." });
    expect(result.text).toContain("Line one.");
    expect(result.text).toContain("Line two.");
    expect(result.html).toContain("Line one.");
    expect(result.html).toContain("PAY2PAY");
  });

  it("escapes a malicious display name embedded in the body instead of rendering it as HTML", () => {
    const result = renderBrandedEmail({ subject: "Hello", body: `<img src=x onerror="alert(1)"> has invited you` });
    expect(result.html).not.toContain("<img src=x onerror=");
    expect(result.html).toContain("&lt;img");
  });

  it("renders a CTA button and includes the link in both html and text when ctaUrl is provided", () => {
    const result = renderBrandedEmail({ subject: "Hello", body: "Body", ctaUrl: "https://app.test/agreements/detail?id=abc", ctaText: "Review agreement" });
    expect(result.html).toContain("https://app.test/agreements/detail?id=abc");
    expect(result.html).toContain("Review agreement");
    expect(result.text).toContain("https://app.test/agreements/detail?id=abc");
  });

  it("omits any CTA markup when ctaUrl is absent", () => {
    const result = renderBrandedEmail({ subject: "Hello", body: "Body" });
    expect(result.html).not.toContain("<a href=");
  });

  it("refuses to render a non-http(s) ctaUrl (e.g. javascript:) as a link", () => {
    const result = renderBrandedEmail({ subject: "Hello", body: "Body", ctaUrl: "javascript:alert(1)", ctaText: "Click me" });
    expect(result.html).not.toContain("<a href=");
    expect(result.html).not.toContain("javascript:alert(1)");
  });

  it("sanitizes CR/LF out of the subject used in the hidden preheader", () => {
    const result = renderBrandedEmail({ subject: "Hello\r\nBcc: evil@example.com", body: "Body" });
    expect(result.html).not.toContain("Bcc: evil@example.com\n");
  });
});
