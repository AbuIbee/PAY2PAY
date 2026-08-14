import type { Metadata } from "next";
import Link from "next/link";
import { NotificationCenter } from "@/components/NotificationCenter";

export const metadata: Metadata = { title: "Notifications" };

export default function NotificationsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Notifications</h1>
        <Link href="/account/notifications" className="button button--ghost">
          Preferences
        </Link>
      </div>
      <NotificationCenter />
    </div>
  );
}
