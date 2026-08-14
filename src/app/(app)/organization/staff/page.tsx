import type { Metadata } from "next";
import { OrganizationStaff } from "@/components/OrganizationStaff";

export const metadata: Metadata = { title: "Staff" };

export default function OrganizationStaffPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Staff</h1>
      </div>
      <OrganizationStaff />
    </div>
  );
}
