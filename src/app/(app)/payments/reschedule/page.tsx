import type { Metadata } from "next";
import { Suspense } from "react";
import { RescheduleRequest } from "@/components/RescheduleRequest";

export const metadata: Metadata = { title: "Reschedule payment" };

export default function ReschedulePage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Reschedule payment</h1>
      </div>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <RescheduleRequest />
      </Suspense>
    </div>
  );
}
