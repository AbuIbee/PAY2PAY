import type { Metadata } from "next";
import { AdminUsers } from "@/components/AdminUsers";

export const metadata: Metadata = { title: "Admin | Users" };

export default function AdminUsersPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Users</h1>
      </div>
      <AdminUsers />
    </div>
  );
}
