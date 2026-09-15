/**
 * Shared shell for the footer's legal/support placeholder routes (Sprint 1
 * item 10). Explicitly marked as unfinished — do not add real legal
 * language here without counsel review (docs/COMPLIANCE_REVIEW_CHECKLIST.md).
 */
export function LegalPlaceholder({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children?: React.ReactNode;
}) {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <div className="section-heading" style={{ textAlign: "left", marginInline: 0, maxWidth: "42rem" }}>
        <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
          {title}
        </h1>
        <p>{intro}</p>
      </div>
      <div
        className="form-status form-status--error"
        style={{ maxWidth: "42rem", marginBottom: "2rem" }}
        role="note"
      >
        {/*
          B0-A (public-surface remediation): removed the internal `docs/COMPLIANCE_REVIEW_CHECKLIST.md`
          path that used to be rendered here — see this file's own doc comment above, which still
          names it for developers. The rest of this placeholder banner's substantive wording is
          deliberately left unchanged: this pass's own scope rule permits only removing an internal
          information leak from Privacy/Terms, not otherwise rewriting them (B0-C will replace this
          banner and both pages' content entirely).
        */}
        This page is a placeholder. The content below is not final legal language and has not been
        reviewed by counsel. Do not rely on it for any legal determination.
      </div>
      <div style={{ maxWidth: "42rem", color: "var(--ink-soft)", lineHeight: 1.7 }}>{children}</div>
    </article>
  );
}
