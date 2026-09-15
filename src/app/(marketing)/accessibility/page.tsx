import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Accessibility",
};

/**
 * B0-A (public-surface remediation): replaces the prior LegalPlaceholder-based placeholder, which
 * exposed an internal repository path (docs/deliverables/05-nonfunctional-requirements.md) and
 * "in active development" prelaunch language. This page makes no conformance claim this repository
 * cannot support — no formal WCAG 2.1/2.2 AA conformance, ADA certification, or third-party audit has
 * been performed (none was found anywhere in the codebase or its documentation), so this states a
 * commitment and an improvement process instead of an achieved certification, per this pass's own
 * explicit instruction.
 */
export default function AccessibilityPage() {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <div className="section-heading" style={{ textAlign: "left", marginInline: 0, maxWidth: "42rem" }}>
        <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
          Accessibility
        </h1>
      </div>
      <div style={{ maxWidth: "42rem", color: "var(--ink-soft)", lineHeight: 1.7 }}>
        <p>
          Paid2You is committed to providing an accessible experience for everyone, including people
          who use assistive technology, and to improving accessibility as the service evolves.
        </p>
        <p>
          We have not completed a formal accessibility conformance assessment, and we do not claim
          conformance with WCAG 2.1 AA, WCAG 2.2 AA, or any other formal accessibility standard, and we
          have not received ADA certification or a third-party accessibility audit. Accessibility
          improvements are an ongoing part of how we build Paid2You.
        </p>
        <p>
          If you encounter an accessibility barrier anywhere on this site, please let us know through
          the <Link href="/support">support</Link> page and describe what you experienced — including
          the page you were on and the assistive technology you were using, if applicable. We use
          reports like this to prioritize fixes.
        </p>
      </div>
    </article>
  );
}
