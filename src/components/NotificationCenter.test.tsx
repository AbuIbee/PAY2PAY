import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationCenter } from "./NotificationCenter";

function mockFetchOnce(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  });
}

describe("NotificationCenter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an empty state when there are no notifications", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ notifications: [] }));
    render(<NotificationCenter />);
    expect(await screen.findByText(/no notifications yet/i)).toBeInTheDocument();
  });

  it("renders an unread notification with a deep link to its agreement", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({
        notifications: [
          {
            id: "notif-1",
            notificationType: "agreement_signed",
            critical: false,
            relatedAgreementId: "agreement-1",
            relatedPaymentAttemptId: null,
            payload: {},
            readAt: null,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    render(<NotificationCenter />);

    expect(await screen.findByText(/agreement signed/i)).toBeInTheDocument();
    expect(screen.getByText(/unread/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /view agreement/i });
    expect(link).toHaveAttribute("href", "/agreements/detail?id=agreement-1");
  });

  it("marks a notification read and calls the read endpoint", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input === "/api/notifications") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            notifications: [
              {
                id: "notif-1",
                notificationType: "payment_cleared",
                critical: false,
                relatedAgreementId: null,
                relatedPaymentAttemptId: null,
                payload: {},
                readAt: null,
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ notification: {} }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<NotificationCenter />);

    const markReadButton = await screen.findByRole("button", { name: /mark read/i });
    await user.click(markReadButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/notifications/read",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "notif-1" }) }),
      );
    });
  });
});
