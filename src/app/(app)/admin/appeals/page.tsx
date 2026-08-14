import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { AdminAppeals } from "@/components/admin/AdminAppeals";

export const metadata: Metadata = { title: "Admin | Appeals" };

export default function AdminAppealsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Appeals</h1>
      </div>
      <AdminGate>
        <AdminAppeals />
      </AdminGate>
    </div>
  );
}
