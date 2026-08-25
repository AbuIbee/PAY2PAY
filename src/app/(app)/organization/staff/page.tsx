import type { Metadata } from "next";
import { ComingSoon } from "@/components/ComingSoon";

export const metadata: Metadata = { title: "Staff" };

/**
 * Organization Features: Coming Soon treatment — StaffService.requireActiveStaff (which every
 * /api/staff/* route this page depends on goes through) requires the caller already hold an active
 * business_staff_member row; BusinessProfileService.createBusinessProfile has never seeded one for
 * the owner, so this page 403'd for every real business owner (the only person who could ever reach
 * it, since inviting the *first* additional staff member requires the same active-staff gate the
 * owner themselves cannot pass). See the dashboard-consistency-fix completion report for the full
 * root-cause writeup; deliberately not fixed broadly here per explicit instruction not to redesign
 * staff/ownership authorization. OrganizationStaff.tsx itself is untouched and simply unmounted for
 * now — no backend authorization was weakened to reach this state.
 */
export default function OrganizationStaffPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Staff</h1>
      </div>
      <ComingSoon feature="Manage Staff" />
    </div>
  );
}
