import type { Metadata } from "next";
import { SupportAppeals } from "@/components/SupportAppeals";

export const metadata: Metadata = { title: "Support" };

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 18: an honest topics list for the new
 * Business subscription/verification surfaces — describes your topic in the form below (the real,
 * working mechanism this page already has), never a claim of a dedicated routing/ticket-category
 * system or live chat channel that doesn't exist.
 */
const BUSINESS_SUPPORT_TOPICS: readonly string[] = [
  "Business verification pending or unavailable",
  "Choosing or changing a subscription plan",
  "Setting up a subscription payment method",
  "A failed subscription payment or past-due invoice",
  "Enterprise billing and custom pricing",
  "Reaching your plan's established-arrangement limit",
  "Team roles and permissions",
];

export default function SupportPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <div>
          <h1>Support</h1>
          <p className="app-page__lede">
            Open a support case, track its status, or appeal an account decision.
          </p>
        </div>
      </div>
      <p>If your question is about any of the following, describe it in the form below:</p>
      <ul>
        {BUSINESS_SUPPORT_TOPICS.map((topic) => (
          <li key={topic}>{topic}</li>
        ))}
      </ul>
      <SupportAppeals />
    </div>
  );
}
