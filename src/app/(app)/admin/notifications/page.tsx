import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { AdminEmailDelivery } from "@/components/admin/AdminEmailDelivery";
import { AdminSmsDelivery } from "@/components/admin/AdminSmsDelivery";

export const metadata: Metadata = { title: "Admin | Notification delivery" };

export default function AdminNotificationsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Notification delivery</h1>
      </div>
      <AdminGate>
        <AdminEmailDelivery />
        <AdminSmsDelivery />
      </AdminGate>
    </div>
  );
}
