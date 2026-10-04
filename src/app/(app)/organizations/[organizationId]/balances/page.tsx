import type { Metadata } from "next";
import { OrganizationBalances } from "@/components/organizations/OrganizationBalances";

export const metadata: Metadata = { title: "Outstanding Balances" };

export default async function OrganizationBalancesPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return (
    <div className="app-page">
      <OrganizationBalances organizationId={organizationId} />
    </div>
  );
}
