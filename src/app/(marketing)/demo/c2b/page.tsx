import type { Metadata } from "next";
import { C2BDemo } from "@/components/demo/C2BDemo";

export const metadata: Metadata = {
  title: "C2B Demo",
  description: "See a customer-to-business repayment journey on PAY2PAY — no account required.",
};

export default function C2BDemoPage() {
  return (
    <section className="section" aria-labelledby="c2b-demo-heading">
      <div className="section-heading">
        <span className="eyebrow"><span /> No signup required</span>
        <h2 id="c2b-demo-heading">C2B Demo</h2>
        <p>A customer paying down a balance owed to a local business, using fictional sample data only.</p>
      </div>
      <C2BDemo />
    </section>
  );
}
