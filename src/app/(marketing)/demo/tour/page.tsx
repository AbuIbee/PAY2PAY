import type { Metadata } from "next";
import { ProductTour } from "@/components/demo/ProductTour";

export const metadata: Metadata = {
  title: "Product Tour",
  description: "A guided tour of Paid2You's primary areas — no account required.",
};

export default function ProductTourPage() {
  return (
    <section className="section" aria-labelledby="product-tour-heading">
      <div className="section-heading">
        <span className="eyebrow"><span /> No signup required</span>
        <h2 id="product-tour-heading">Product Tour</h2>
        <p>A guided look at what each part of Paid2You is for, what you can do there, and what comes next.</p>
      </div>
      <ProductTour />
    </section>
  );
}
