import { describe, expect, it } from "vitest";
import { DEFAULT_CHANNELS, type NotificationEventType } from "@/lib/notify/eventTypes";
import {
  agreementStatusLabel,
  appealDecisionLabel,
  creditorPayoutStatusLabel,
  notificationDeliveryStatusLabel,
  notificationEventLabel,
  payoutAttemptStatusLabel,
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

  describe("accurate creditor payout reporting (SC-08)", () => {
    it("only 'confirmed' ever makes an affirmative paid claim — pending/failed/returned all read as still owed, never merely negated", () => {
      expect(payoutAttemptStatusLabel("confirmed").label).toBe("Paid to you");
      for (const status of ["pending", "failed", "returned"] as const) {
        const { label } = payoutAttemptStatusLabel(status);
        expect(label.toLowerCase()).toContain("owed");
        expect(label.toLowerCase()).not.toContain("transferred");
        expect(label).not.toBe("Paid to you");
      }
    });

    it("gives failed and returned distinct, non-success tones from confirmed — color is never the only signal, and neither ever reads as success", () => {
      expect(payoutAttemptStatusLabel("confirmed").tone).toBe("success");
      expect(payoutAttemptStatusLabel("failed").tone).not.toBe("success");
      expect(payoutAttemptStatusLabel("returned").tone).not.toBe("success");
    });

    it("creditorPayoutStatusLabel never says 'Paid'/'Transferred' from payment clearance or initiation alone — only a genuinely confirmed payout_attempt does", () => {
      // A cleared payment with NO payout_attempt recorded yet is exactly the "payout initiated but
      // not confirmed" shape this rule exists to guard against — must never read as paid.
      expect(creditorPayoutStatusLabel("succeeded", null).label).not.toBe("Paid to you");
      expect(creditorPayoutStatusLabel("succeeded", "pending").label).not.toBe("Paid to you");
      expect(creditorPayoutStatusLabel("succeeded", "failed").label).not.toBe("Paid to you");
      expect(creditorPayoutStatusLabel("succeeded", "returned").label).not.toBe("Paid to you");
      // The ONLY combination that may say "Paid to you."
      expect(creditorPayoutStatusLabel("succeeded", "confirmed").label).toBe("Paid to you");
    });

    it("a payment that hasn't even cleared shows 'Not yet owed', never any payout-owed language", () => {
      const label = creditorPayoutStatusLabel("pending", null);
      expect(label).toEqual({ label: "Not yet owed", tone: "neutral" });
    });

    it("distinguishes all four payout_attempt states with distinct, non-empty labels (Pending/Confirmed/Failed/Returned)", () => {
      const labels = (["pending", "confirmed", "failed", "returned"] as const).map((s) => payoutAttemptStatusLabel(s).label);
      expect(new Set(labels).size).toBe(4);
      for (const label of labels) expect(label.length).toBeGreaterThan(0);
    });
  });
});
