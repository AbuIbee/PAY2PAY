import type { Metadata } from "next";
import { AdminBusinesses } from "@/components/admin/AdminBusinesses";

export const metadata: Metadata = { title: "Admin | Businesses" };

export default function AdminBusinessesPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Businesses</h1>
      </div>
      <AdminBusinesses />
    </div>
  );
}
