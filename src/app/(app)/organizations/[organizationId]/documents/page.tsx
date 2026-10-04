import type { Metadata } from "next";
import { OrganizationUnavailableResource } from "@/components/organizations/OrganizationUnavailableResource";

export const metadata: Metadata = { title: "Documents" };

export default async function OrganizationDocumentsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return (
    <div className="app-page">
      <OrganizationUnavailableResource
        organizationId={organizationId}
        permissionKey="documents.view"
        title="Documents"
        message="No business documents have been added yet."
      />
    </div>
  );
}
