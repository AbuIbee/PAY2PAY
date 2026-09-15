import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DemoPage from "./page";
import { metadata as p2pMetadata } from "./p2p/page";
import { metadata as c2bMetadata } from "./c2b/page";
import { metadata as b2bMetadata } from "./b2b/page";
import { metadata as tourMetadata } from "./tour/page";

/**
 * B0-A: covers every demo page's stale-brand instances. The hub page (/demo) renders "Paid2You" in
 * JSX directly, so it's covered by rendering; the four dedicated demo pages (/demo/p2p, /demo/c2b,
 * /demo/b2b, /demo/tour) only had the stale brand in their exported `metadata.description` — which
 * Next.js applies outside the rendered component tree — so those are checked by importing `metadata`
 * directly rather than rendering.
 */
describe("Demo pages (B0-A: branding)", () => {
  it("demo hub renders the current Paid2You brand, not the stale PAY2PAY name", () => {
    render(<DemoPage />);
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("PAY2PAY");
    expect(bodyText).toContain("Paid2You");
  });

  it.each([
    ["p2p", p2pMetadata],
    ["c2b", c2bMetadata],
    ["b2b", b2bMetadata],
    ["tour", tourMetadata],
  ])("%s demo page metadata uses Paid2You, not the stale PAY2PAY name", (_name, metadata) => {
    const description = String(metadata.description ?? "");
    expect(description).toContain("Paid2You");
    expect(description).not.toContain("PAY2PAY");
  });
});
