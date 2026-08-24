import type { Metadata } from "next";
import { SupportAppeals } from "@/components/SupportAppeals";

export const metadata: Metadata = { title: "Support" };

export default function SupportPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <div>
          <h1>Support</h1>
          <p className="app-page__lede">
            Open a support case, track its status, or appeal an account decision.
          </p>
        </div>
      </div>
      <SupportAppeals />
    </div>
  );
}
