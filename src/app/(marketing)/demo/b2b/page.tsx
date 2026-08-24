import type { Metadata } from "next";
import { B2BDemo } from "@/components/demo/B2BDemo";

export const metadata: Metadata = {
  title: "B2B Demo",
  description: "See a business-to-business repayment journey on PAY2PAY — no account required.",
};

export default function B2BDemoPage() {
  return (
    <section className="section" aria-labelledby="b2b-demo-heading">
      <div className="section-heading">
        <span className="eyebrow"><span /> No signup required</span>
        <h2 id="b2b-demo-heading">B2B Demo</h2>
        <p>One business repaying another on an agreed plan, using fictional sample companies only.</p>
      </div>
      <B2BDemo />
    </section>
  );
}
