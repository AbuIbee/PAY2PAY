import { LEGAL_EFFECTIVE_DATE, LEGAL_LAST_UPDATED } from "@/lib/legal/legalMeta";

/**
 * B0-C (Privacy Policy / Terms of Service): shared presentational shell for the two public legal
 * documents. Replaces `LegalPlaceholder.tsx` for these two pages now that both have real,
 * substantive content — `LegalPlaceholder` itself is left in place (it is explicitly a placeholder
 * shell and is no longer imported by either page after this pass, but deleting it is unrelated
 * cleanup outside this pass's scope).
 *
 * Deliberately minimal: reuses this codebase's existing marketing-page typography conventions (the
 * same Georgia-serif H1 / `--ink-soft` body-copy treatment already used by
 * `(marketing)/accessibility/page.tsx` and the removed `LegalPlaceholder`) rather than introducing a
 * new design system, per this pass's own explicit instruction not to build an elaborate one.
 */
export function LegalDocument({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem", paddingBlockEnd: "3rem" }}>
      <div className="section-heading" style={{ textAlign: "left", marginInline: 0, maxWidth: "46rem" }}>
        <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
          {title}
        </h1>
        <p style={{ margin: "0.75rem 0 0", color: "var(--ink-soft)", fontSize: "0.9rem" }}>
          Effective Date: {LEGAL_EFFECTIVE_DATE}
          <br />
          Last Updated: {LEGAL_LAST_UPDATED}
        </p>
      </div>
      <div style={{ maxWidth: "46rem", color: "var(--ink-soft)", lineHeight: 1.7 }}>{children}</div>
    </article>
  );
}

/**
 * One numbered/topical section within a legal document. `id` backs the heading's own anchor
 * (`aria-labelledby`) so the section hierarchy is genuinely semantic/navigable, not just visually
 * implied — satisfies this pass's own "accessible semantic headings" requirement.
 */
export function LegalSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} style={{ marginTop: "2.25rem" }}>
      <h2 id={id} style={{ fontSize: "var(--text-lg)", fontWeight: 650, margin: "0 0 0.75rem", color: "var(--ink)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}
