import type { Metadata } from "next";
import { SupportAppeals } from "@/components/SupportAppeals";

export const metadata: Metadata = { title: "Support" };

export default function SupportPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Support</h1>
      </div>
      <SupportAppeals />
    </div>
  );
}
