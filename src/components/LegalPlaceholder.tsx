/**
 * Shared shell for the footer's legal/support document routes (Sprint 1 item 10).
 *
 * "PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 8-I: this component previously
 * rendered an alarming "this page is a placeholder, do not rely on it" banner to every production
 * visitor. The owner has directed that a production-facing legal page must display coherent,
 * complete draft content without obvious development-placeholder messaging. The underlying
 * draft/not-yet-counsel-reviewed status is real and is NOT deleted — it is tracked where it
 * belongs, in `docs/PRODUCTION_LEGAL_REVIEW.md` (OWNER APPROVED / LEGAL APPROVED both remain `NO`
 * there until the owner or counsel actually signs off) rather than shouted at every reader of the
 * page itself. This component must never be changed to claim legal/counsel approval — only the
 * document's version is shown, never an approval or "reviewed" claim.
 */
export function LegalPlaceholder({
  title,
  intro,
  version,
  children,
}: {
  title: string;
  intro: string;
  /** "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 4: the exact version string a legal-acceptance record for this document would store — displayed so a reader can see which version they are looking at, never computed independently of CURRENT_LEGAL_DOCUMENT_VERSIONS. */
  version?: string;
  children?: React.ReactNode;
}) {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <div className="section-heading" style={{ textAlign: "left", marginInline: 0, maxWidth: "42rem" }}>
        <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
          {title}
        </h1>
        <p>{intro}</p>
        {version ? (
          <p style={{ fontSize: "var(--text-sm)", color: "var(--ink-soft)" }}>
            Last updated: <code>{version}</code>
          </p>
        ) : null}
      </div>
      <div style={{ maxWidth: "42rem", color: "var(--ink-soft)", lineHeight: 1.7 }}>{children}</div>
    </article>
  );
}
