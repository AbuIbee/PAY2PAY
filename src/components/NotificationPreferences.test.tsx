import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationPreferences } from "./NotificationPreferences";

/**
 * B0-B: routes by URL, since the component now fetches both `/api/notifications/preferences` and
 * `/api/notifications/sms-consent` in parallel. `consentOverrides` defaults to an already-active,
 * fully-eligible consent state — mirroring `createTestNotificationService`'s own identical
 * "permissive-by-default shared fixture" convention (see that file's own doc comment) — so the
 * pre-existing tests below, which are about the per-type channel matrix and not about the consent
 * gate itself, don't need to separately configure consent for a precondition they aren't testing.
 * Tests that specifically exercise the consent control override this explicitly.
 */
function mockPreferencesResponse(
  overrides: Partial<{ preferences: unknown[]; smsEligibility: unknown; smsProviderAvailable: boolean }> = {},
  consentOverrides: Partial<{ active: boolean; effectiveActive: boolean; eligibility: unknown }> = {},
) {
  const smsEligibility = (overrides.smsEligibility as object | undefined) ?? { phoneVerified: true, maskedPhone: "+1********67", optedOut: false };
  return vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/notifications/sms-consent")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          active: true,
          effectiveActive: true,
          consentedAt: new Date().toISOString(),
          withdrawnAt: null,
          source: "web_form",
          disclosureVersion: "test",
          eligibility: smsEligibility,
          currentDisclosureVersion: "test",
          ...consentOverrides,
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        preferences: [],
        smsEligibility,
        smsProviderAvailable: true,
        ...overrides,
      }),
    };
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

  describe("B0-B: master SMS consent control", () => {
    it("shows the control OFF for a user with no recorded consent — never preselected", async () => {
      vi.stubGlobal("fetch", mockPreferencesResponse({}, { active: false, effectiveActive: false }));
      render(<NotificationPreferences />);
      const toggle = await screen.findByLabelText(/receive transactional text messages from paid2you/i);
      expect(toggle).not.toBeChecked();
    });

    it("reflects an already-active, persisted consent state as checked", async () => {
      vi.stubGlobal("fetch", mockPreferencesResponse({}, { active: true, effectiveActive: true }));
      render(<NotificationPreferences />);
      const toggle = await screen.findByLabelText(/receive transactional text messages from paid2you/i);
      expect(toggle).toBeChecked();
    });

    it("enabling requires explicit user action — clicking the control posts enabled:true", async () => {
      const fetchMock = mockPreferencesResponse({}, { active: false, effectiveActive: false });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<NotificationPreferences />);
      const toggle = await screen.findByLabelText(/receive transactional text messages from paid2you/i);
      expect(toggle).not.toBeChecked();
      await user.click(toggle);
      await waitFor(() => {
        const postCall = fetchMock.mock.calls.find(
          (call) => String(call[0]).includes("/api/notifications/sms-consent") && call[1]?.method === "POST",
        );
        expect(postCall).toBeTruthy();
        expect(JSON.parse(postCall![1].body as string)).toEqual({ enabled: true });
      });
    });

    it("the control is disabled (cannot be turned on) when no verified phone exists", async () => {
      vi.stubGlobal(
        "fetch",
        mockPreferencesResponse(
          { smsEligibility: { phoneVerified: false, maskedPhone: null, optedOut: false } },
          { active: false, effectiveActive: false },
        ),
      );
      render(<NotificationPreferences />);
      const toggle = await screen.findByLabelText(/receive transactional text messages from paid2you/i);
      expect(toggle).toBeDisabled();
    });

    it("shows Terms and Privacy links adjacent to the consent disclosure", async () => {
      vi.stubGlobal("fetch", mockPreferencesResponse({}, { active: false, effectiveActive: false }));
      render(<NotificationPreferences />);
      await screen.findByLabelText(/receive transactional text messages from paid2you/i);
      expect(screen.getByRole("link", { name: /^terms$/i })).toHaveAttribute("href", "/terms");
      expect(screen.getByRole("link", { name: /privacy policy/i })).toHaveAttribute("href", "/privacy");
    });

    it("the disclosure communicates transactional purpose, variable frequency, message/data rates, STOP, HELP, and that consent is not required", async () => {
      vi.stubGlobal("fetch", mockPreferencesResponse({}, { active: false, effectiveActive: false }));
      render(<NotificationPreferences />);
      await screen.findByLabelText(/receive transactional text messages from paid2you/i);
      const bodyText = document.body.textContent ?? "";
      expect(bodyText).toMatch(/transactional text messages/i);
      expect(bodyText).toMatch(/message frequency varies/i);
      expect(bodyText).toMatch(/message and data rates may apply/i);
      expect(bodyText).toMatch(/reply stop/i);
      expect(bodyText).toMatch(/help for assistance/i);
      expect(bodyText).toMatch(/consent is not required to use paid2you/i);
    });

    it("introduces no marketing/promotional language", async () => {
      vi.stubGlobal("fetch", mockPreferencesResponse({}, { active: false, effectiveActive: false }));
      render(<NotificationPreferences />);
      await screen.findByLabelText(/receive transactional text messages from paid2you/i);
      const bodyText = (document.body.textContent ?? "").toLowerCase();
      expect(bodyText).not.toContain("marketing");
      expect(bodyText).not.toContain("promotional");
      expect(bodyText).not.toContain("special offer");
      expect(bodyText).not.toContain("deals");
    });

    it("existing email preference behavior is unaffected by the SMS consent control", async () => {
      vi.stubGlobal("fetch", mockPreferencesResponse({}, { active: false, effectiveActive: false }));
      render(<NotificationPreferences />);
      const row = (await screen.findByText(/amendment update/i)).closest("tr");
      if (!row) throw new Error("expected a row");
      const emailCheckbox = within(row).getByLabelText(/^email$/i);
      expect(emailCheckbox).toBeChecked();
      expect(emailCheckbox).not.toBeDisabled();
    });
  });
});
