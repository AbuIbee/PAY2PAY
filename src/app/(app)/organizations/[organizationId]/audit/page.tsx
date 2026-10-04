import type { Metadata } from "next";
import { OrganizationUnavailableResource } from "@/components/organizations/OrganizationUnavailableResource";

export const metadata: Metadata = { title: "Audit History" };

export default async function OrganizationAuditPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return (
    <div className="app-page">
      <OrganizationUnavailableResource
        organizationId={organizationId}
        permissionKey="audit.view"
        title="Audit History"
        message="Audit history viewing is not available yet."
      />
    </div>
  );
}
