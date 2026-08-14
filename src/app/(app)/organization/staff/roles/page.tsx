import type { Metadata } from "next";
import { OrganizationStaffRoles } from "@/components/OrganizationStaffRoles";

export const metadata: Metadata = { title: "Custom roles" };

export default function OrganizationStaffRolesPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Custom roles</h1>
      </div>
      <OrganizationStaffRoles />
    </div>
  );
}
