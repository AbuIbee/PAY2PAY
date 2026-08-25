import type { Metadata } from "next";
import { ComingSoon } from "@/components/ComingSoon";

export const metadata: Metadata = { title: "Approvals" };

/**
 * Organization Features: Coming Soon treatment — same root cause as /organization/staff (this page's
 * data also depends on StaffService.requireActiveStaff, which a real business owner cannot pass).
 * See that page's own doc comment for the full explanation. OrganizationApprovals.tsx itself is
 * untouched; no backend authorization was weakened.
 */
export default function OrganizationApprovalsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Approvals</h1>
      </div>
      <ComingSoon feature="Approvals" />
    </div>
  );
}
