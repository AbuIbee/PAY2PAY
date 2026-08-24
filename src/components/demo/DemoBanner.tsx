/**
 * Demo navigation & dedicated demo experiences (Product Owner request): the required, exact banner
 * text for every dedicated demo route — distinct from DemoWalkthrough.tsx's own pre-existing banner
 * text ("DEMO — No real money or accounts are being used."), which is left untouched on purpose
 * (already covered by its own passing tests). This component makes no network calls and holds no
 * state — pure display.
 */
export function DemoBanner() {
  return (
    <div
      role="status"
      style={{
        padding: "0.85rem 1.1rem",
        borderRadius: "0.8rem",
        background: "var(--gold-soft)",
        color: "#7a5610",
        fontWeight: 750,
        fontSize: "0.85rem",
        textAlign: "center",
      }}
    >
      DEMO — No real money or customer data is being used.
    </div>
  );
}
