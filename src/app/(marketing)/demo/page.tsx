import type { Metadata } from "next";
import { DemoWalkthrough } from "@/components/DemoWalkthrough";

export const metadata: Metadata = {
  title: "Try the demo",
  description: "See how PAY2PAY works with guided example scenarios — no account required.",
};

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
      <DemoWalkthrough />
    </section>
  );
}
