/**
 * Organization Features: Coming Soon treatment (pre-merge UX remediation) — the shared, informational
 * "not yet production-ready" state for a feature whose backend is not currently usable end-to-end.
 * Deliberately reuses the same `empty-state` pattern already established by CardsManager.tsx's own
 * "Not yet available" state, rather than inventing a second visual treatment. Never rendered as an
 * error (no `role="alert"`, no error styling) — this is an intentionally deferred feature, not a
 * failure. `role="status"` + visible text (not color alone) so the non-interactive state is
 * announced and legible without relying on any styling cue.
 */
export function ComingSoon({ feature, description }: { feature: string; description?: string }) {
  return (
    <div className="empty-state" role="status">
      <h3>{feature}</h3>
      <p className="chip chip--neutral" style={{ display: "inline-block" }}>
        Coming Soon
      </p>
      <p>{description ?? "This feature is coming soon. We'll let you know when it's ready."}</p>
    </div>
  );
}
