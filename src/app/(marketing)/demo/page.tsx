import type { Metadata } from "next";
import Link from "next/link";
import { DemoWalkthrough } from "@/components/DemoWalkthrough";

export const metadata: Metadata = {
  title: "Try the demo",
  description: "See how PAY2PAY works with guided example scenarios — no account required.",
};

/**
 * Demo navigation & dedicated demo experiences (Product Owner request): links into the four
 * dedicated demo routes (/demo/p2p, /demo/c2b, /demo/b2b, /demo/tour) — new this pass, additive
 * only. The existing inline DemoWalkthrough below is unchanged and still fully functional.
 */
const DEDICATED_DEMOS = [
  { href: "/demo/p2p", tag: "P2P", label: "P2P Demo", description: "Person A owes Person B $1,000" },
  { href: "/demo/c2b", tag: "C2B", label: "C2B Demo", description: "A customer owes a local business $600" },
  { href: "/demo/b2b", tag: "B2B", label: "B2B Demo", description: "Business A owes Business B $5,000" },
  { href: "/demo/tour", tag: "TOUR", label: "Product Tour", description: "A guided tour of PAY2PAY's primary areas" },
];

export default function DemoPage() {
  return (
    <section className="section" aria-labelledby="demo-heading">
      <div className="section-heading">
        <span className="eyebrow"><span /> No signup required</span>
        <h2 id="demo-heading">See PAY2PAY in action.</h2>
        <p>
          Walk through a few example repayment scenarios with sample people and businesses. Nothing
          here is real — no account is created, no agreement is saved, and no money moves.
        </p>
      </div>

      <nav aria-label="Dedicated demo experiences" className="relationship-grid" style={{ marginBottom: "2rem" }}>
        {DEDICATED_DEMOS.map((demo) => (
          <Link key={demo.href} href={demo.href} className="relationship-card" aria-label={demo.label}>
            <div className="relationship-card__tag">{demo.tag}</div>
            <div>
              <h3>{demo.label}</h3>
              <p>{demo.description}</p>
            </div>
            <span className="relationship-card__arrow" aria-hidden="true">↗</span>
          </Link>
        ))}
      </nav>

      <DemoWalkthrough />
    </section>
  );
}
