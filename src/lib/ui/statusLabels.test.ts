import { describe, expect, it } from "vitest";
import { DEFAULT_CHANNELS, type NotificationEventType } from "@/lib/notify/eventTypes";
import {
  agreementStatusLabel,
  appealDecisionLabel,
  notificationDeliveryStatusLabel,
  notificationEventLabel,
  relationshipStatusLabel,
  settlementProposalStatusLabel,
} from "./statusLabels";

describe("statusLabels registries", () => {
  it("never leaks a raw enum string for a known value", () => {
    expect(agreementStatusLabel("awaiting_debtor_acknowledgment")).toEqual({
      label: "Awaiting acknowledgment",
      tone: "info",
    });
    expect(relationshipStatusLabel("counterparty_linked").label).toBe("Connected");
  });

  it("falls back to the raw value (not a crash) for an unrecognized status, so a future backend value never breaks rendering", () => {
    // @ts-expect-error deliberately passing a value outside the known union to exercise the fallback
    expect(agreementStatusLabel("some_future_status")).toEqual({ label: "some_future_status", tone: "neutral" });
  });

  it("keeps 'accepted' and 'completed' visually distinct for settlements — the spec's hard rule", () => {
    const accepted = settlementProposalStatusLabel("awaiting_payment");
    const completed = settlementProposalStatusLabel("completed");
    expect(accepted.label).not.toBe(completed.label);
    expect(accepted.tone).not.toBe(completed.tone);
    expect(accepted.label.toLowerCase()).not.toContain("completed");
    expect(accepted.label.toLowerCase()).not.toContain("paid");
  });

  it("every StatusLabel carries a non-empty label so a chip is never color-only", () => {
    for (const value of ["upheld", "overturned", "partially_overturned"] as const) {
      expect(appealDecisionLabel(value).label.length).toBeGreaterThan(0);
    }
  });

  it(
    "PRSprint 16 (docs/prsprints/PRSPRINT_16_NOTIFICATION_PREFERENCES_DELIVERY_HISTORY.md), " +
      "requirement #19: every NotificationEventType has a human label, not a raw enum-string fallback " +
      "— the PRSprint 13 gap (four types that previously rendered their raw type name in the " +
      "Notification Center) is included here specifically so it can't silently regress",
    () => {
      for (const type of Object.keys(DEFAULT_CHANNELS) as NotificationEventType[]) {
        const label = notificationEventLabel[type];
        expect(label, `missing a label for "${type}"`).toBeTruthy();
        expect(label).not.toBe(type);
      }
    },
  );

  it("notificationDeliveryStatusLabel never uses infrastructure terminology and covers every real status", () => {
    for (const status of ["pending", "sent", "delivered", "failed", "not_sent"] as const) {
      const label = notificationDeliveryStatusLabel(status);
      expect(label.label.length).toBeGreaterThan(0);
      expect(label.label.toLowerCase()).not.toContain("provider");
    }
    // "sent" and "delivered" must stay visually/textually distinct — see notificationService.ts's own
    // "provider accepted" vs "provider-confirmed delivery" distinction this reflects.
    expect(notificationDeliveryStatusLabel("sent").label).not.toBe(notificationDeliveryStatusLabel("delivered").label);
  });
});
