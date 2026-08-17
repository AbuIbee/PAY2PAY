import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { AdminEmailDelivery } from "@/components/admin/AdminEmailDelivery";

export const metadata: Metadata = { title: "Admin | Email delivery" };

export default function AdminNotificationsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Email delivery</h1>
      </div>
      <AdminGate>
        <AdminEmailDelivery />
      </AdminGate>
    </div>
  );
}
