import type { Metadata } from "next";
import { ComingSoon } from "@/components/ComingSoon";

export const metadata: Metadata = { title: "Custom roles" };

/**
 * Organization Features: Coming Soon treatment — same root cause as /organization/staff (this page's
 * data also depends on StaffService.requireActiveStaff, which a real business owner cannot pass).
 * See that page's own doc comment for the full explanation. OrganizationStaffRoles.tsx itself is
 * untouched; no backend authorization was weakened.
 */
export default function OrganizationStaffRolesPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Custom roles</h1>
      </div>
      <ComingSoon feature="Custom Roles" />
    </div>
  );
}
