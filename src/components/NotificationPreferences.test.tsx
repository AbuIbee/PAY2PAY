import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationPreferences } from "./NotificationPreferences";

function mockPreferencesResponse(overrides: Partial<{ preferences: unknown[]; smsEligibility: unknown; smsProviderAvailable: boolean }> = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      preferences: [],
      smsEligibility: { phoneVerified: true, maskedPhone: "+1********67", optedOut: false },
      smsProviderAvailable: true,
      ...overrides,
    }),
  });
}

describe("NotificationPreferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders critical-type channel toggles as checked and disabled, never a plain unchecked/absent control", async () => {
    vi.stubGlobal("fetch", mockPreferencesResponse());
    render(<NotificationPreferences />);

    // payment_failed is one of the critical types (src/lib/notify/eventTypes.ts) and includes sms.
    const row = (await screen.findByText(/payment failed/i)).closest("tr");
    if (!row) throw new Error("expected a table row for payment_failed");
    const withinRow = within(row);
    expect(withinRow.getByText(/required/i)).toBeInTheDocument();
    for (const checkbox of withinRow.getAllByRole("checkbox")) {
      expect(checkbox).toBeChecked();
      expect(checkbox).toBeDisabled();
    }
  });

  it("renders a non-critical type's channel toggle as enabled and defaulting to on when no preference row exists", async () => {
    vi.stubGlobal("fetch", mockPreferencesResponse());
    render(<NotificationPreferences />);

    const row = (await screen.findByText(/amendment update/i)).closest("tr");
    if (!row) throw new Error("expected a table row for amendment");
    const withinRow = within(row);
    expect(withinRow.queryByText(/required/i)).not.toBeInTheDocument();
    for (const checkbox of withinRow.getAllByRole("checkbox")) {
      expect(checkbox).toBeChecked();
      expect(checkbox).not.toBeDisabled();
    }
  });

  it("disables SMS (unchecked, not merely defaulted) and explains why when no phone is verified", async () => {
    vi.stubGlobal(
      "fetch",
      mockPreferencesResponse({ smsEligibility: { phoneVerified: false, maskedPhone: null, optedOut: false } }),
    );
    render(<NotificationPreferences />);

    expect(await screen.findByText(/verify a phone number to enable text messages/i)).toBeInTheDocument();
    const row = (await screen.findByText(/amendment update/i)).closest("tr");
    if (!row) throw new Error("expected a row");
    const smsCheckbox = within(row).getByLabelText(/text message/i);
    expect(smsCheckbox).not.toBeChecked();
    expect(smsCheckbox).toBeDisabled();
  });

  it("disables SMS and explains opt-out state when the user has been provider-suppressed", async () => {
    vi.stubGlobal(
      "fetch",
      mockPreferencesResponse({ smsEligibility: { phoneVerified: true, maskedPhone: "+1********67", optedOut: true } }),
    );
    render(<NotificationPreferences />);

    expect(await screen.findByText(/opted out of text messages/i)).toBeInTheDocument();
    const row = (await screen.findByText(/amendment update/i)).closest("tr");
    if (!row) throw new Error("expected a row");
    const smsCheckbox = within(row).getByLabelText(/text message/i);
    expect(smsCheckbox).not.toBeChecked();
    expect(smsCheckbox).toBeDisabled();
  });

  it("disables SMS and explains provider-pending state without using infrastructure terminology", async () => {
    vi.stubGlobal("fetch", mockPreferencesResponse({ smsProviderAvailable: false }));
    render(<NotificationPreferences />);

    const notice = await screen.findByText(/text messages aren't available yet/i);
    expect(notice).toBeInTheDocument();
    const container = notice.closest("div");
    expect(container?.textContent?.toLowerCase()).not.toContain("twilio");
    expect(container?.textContent?.toLowerCase()).not.toContain("provider");
  });

  it("shows a masked phone number, not the full number, when SMS is fully eligible", async () => {
    vi.stubGlobal("fetch", mockPreferencesResponse());
    render(<NotificationPreferences />);
    const notice = await screen.findByText(/verified number ending in/i);
    expect(notice.textContent).not.toContain("+15551234567");
  });
});
