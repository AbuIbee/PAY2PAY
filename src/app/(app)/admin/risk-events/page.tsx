import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { AdminRiskEvents } from "@/components/admin/AdminRiskEvents";

export const metadata: Metadata = { title: "Admin | Risk & fraud signals" };

export default function AdminRiskEventsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Risk &amp; fraud signals</h1>
      </div>
      <AdminGate>
        <AdminRiskEvents />
      </AdminGate>
    </div>
  );
}
