import type { Metadata } from "next";
import { NotificationPreferences } from "@/components/NotificationPreferences";

export const metadata: Metadata = { title: "Notification preferences" };

export default function NotificationPreferencesPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Notification preferences</h1>
      </div>
      <p className="app-page__lede">
        Choose which channels you want to hear from us on. Critical notifications — security,
        payment failures, disputes, and account restrictions — are always on and can&apos;t be
        turned off.
      </p>
      <div style={{ marginTop: "1.5rem" }}>
        <NotificationPreferences />
      </div>
    </div>
  );
}
