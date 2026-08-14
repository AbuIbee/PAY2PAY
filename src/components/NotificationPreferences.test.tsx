import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationPreferences } from "./NotificationPreferences";

describe("NotificationPreferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders critical-type channel toggles as checked and disabled, never a plain unchecked/absent control", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ preferences: [] }) }),
    );
    render(<NotificationPreferences />);

    // payment_failed is one of the 14 critical types (src/lib/notify/eventTypes.ts).
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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ preferences: [] }) }),
    );
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
});
