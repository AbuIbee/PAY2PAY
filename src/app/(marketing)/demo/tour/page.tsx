import type { Metadata } from "next";
import { ProductTour } from "@/components/demo/ProductTour";

export const metadata: Metadata = {
  title: "Product Tour",
  description: "A guided tour of PAY2PAY's primary areas — no account required.",
};

export default function ProductTourPage() {
  return (
    <section className="section" aria-labelledby="product-tour-heading">
      <div className="section-heading">
        <span className="eyebrow"><span /> No signup required</span>
        <h2 id="product-tour-heading">Product Tour</h2>
        <p>A guided look at what each part of PAY2PAY is for, what you can do there, and what comes next.</p>
      </div>
      <ProductTour />
    </section>
  );
}
