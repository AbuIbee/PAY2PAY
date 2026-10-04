import { OrganizationWorkspaceGate } from "@/components/organizations/OrganizationWorkspaceGate";

export default async function OrganizationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  return <OrganizationWorkspaceGate organizationId={organizationId}>{children}</OrganizationWorkspaceGate>;
}
