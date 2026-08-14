import type { Metadata } from "next";
import { OrganizationApprovals } from "@/components/OrganizationApprovals";

export const metadata: Metadata = { title: "Approvals" };

export default function OrganizationApprovalsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Approvals</h1>
      </div>
      <OrganizationApprovals />
    </div>
  );
}
