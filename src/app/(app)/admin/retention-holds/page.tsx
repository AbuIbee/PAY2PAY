import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { AdminRetentionHolds } from "@/components/admin/AdminRetentionHolds";

export const metadata: Metadata = { title: "Admin | Legal holds" };

export default function AdminRetentionHoldsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Legal &amp; retention holds</h1>
      </div>
      <AdminGate>
        <AdminRetentionHolds />
      </AdminGate>
    </div>
  );
}
