import type { Metadata } from "next";
import { P2PDemo } from "@/components/demo/P2PDemo";

export const metadata: Metadata = {
  title: "P2P Demo",
  description: "See a full person-to-person repayment journey on PAY2PAY — no account required.",
};

export default function P2PDemoPage() {
  return (
    <section className="section" aria-labelledby="p2p-demo-heading">
      <div className="section-heading">
        <span className="eyebrow"><span /> No signup required</span>
        <h2 id="p2p-demo-heading">P2P Demo</h2>
        <p>A person-to-person repayment, start to finish, using fictional sample people only.</p>
      </div>
      <P2PDemo />
    </section>
  );
}
