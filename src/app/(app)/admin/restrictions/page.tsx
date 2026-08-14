import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { AdminRestrictions } from "@/components/admin/AdminRestrictions";

export const metadata: Metadata = { title: "Admin | Restrictions" };

export default function AdminRestrictionsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Restrictions</h1>
      </div>
      <AdminGate>
        <AdminRestrictions />
      </AdminGate>
    </div>
  );
}
