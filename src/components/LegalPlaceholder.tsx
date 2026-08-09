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
        This page is a placeholder. The content below is not final legal language and has not been
        reviewed by counsel — see <code>docs/COMPLIANCE_REVIEW_CHECKLIST.md</code>. Do not rely on
        it for any legal determination.
      </div>
      <div style={{ maxWidth: "42rem", color: "var(--ink-soft)", lineHeight: 1.7 }}>{children}</div>
    </article>
  );
}
