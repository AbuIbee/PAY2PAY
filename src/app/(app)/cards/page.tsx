import type { Metadata } from "next";
import { CardsManager } from "@/components/CardsManager";

export const metadata: Metadata = { title: "Cards" };

export default function CardsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <div>
          <h1>Cards</h1>
          <p className="app-page__lede">
            Request and manage debit cards for spending funds you&apos;ve received through PAY2PAY.
          </p>
        </div>
      </div>
      <CardsManager />
    </div>
  );
}
