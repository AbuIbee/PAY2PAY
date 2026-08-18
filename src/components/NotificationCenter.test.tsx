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
            groupId: "group-1",
            notificationType: "agreement_signed",
            critical: false,
            relatedAgreementId: "agreement-1",
            relatedPaymentAttemptId: null,
            payload: {},
            readAt: null,
            inAppId: "notif-in-app-1",
            createdAt: new Date().toISOString(),
            channels: [{ channel: "in_app", status: "delivered", failureReason: null }],
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

  it("marks a notification read (using the group's own in_app row id) and calls the read endpoint", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input === "/api/notifications") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            notifications: [
              {
                groupId: "group-1",
                notificationType: "payment_cleared",
                critical: false,
                relatedAgreementId: null,
                relatedPaymentAttemptId: null,
                payload: {},
                readAt: null,
                inAppId: "notif-in-app-1",
                createdAt: new Date().toISOString(),
                channels: [
                  { channel: "email", status: "sent", failureReason: null },
                  { channel: "in_app", status: "delivered", failureReason: null },
                ],
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
        expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "notif-in-app-1" }) }),
      );
    });
  });

  it("shows a per-channel delivery status chip for email/sms, but not a redundant chip for in_app", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({
        notifications: [
          {
            groupId: "group-1",
            notificationType: "agreement_action_required",
            critical: false,
            relatedAgreementId: null,
            relatedPaymentAttemptId: null,
            payload: {},
            readAt: new Date().toISOString(),
            inAppId: "notif-in-app-1",
            createdAt: new Date().toISOString(),
            channels: [
              { channel: "email", status: "sent", failureReason: null },
              { channel: "sms", status: "not_sent", failureReason: null, reason: "disabled by your notification preference" },
              { channel: "in_app", status: "delivered", failureReason: null },
            ],
          },
        ],
      }),
    );
    render(<NotificationCenter />);

    expect(await screen.findByText(/email: sent/i)).toBeInTheDocument();
    expect(screen.getByText(/text message: not sent/i)).toBeInTheDocument();
    expect(screen.queryByText(/in-app: delivered/i)).not.toBeInTheDocument();
  });

  it("does not show a 'Mark read' button when the group has no in_app row (in-app was disabled by preference)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({
        notifications: [
          {
            groupId: "group-1",
            notificationType: "amendment",
            critical: false,
            relatedAgreementId: null,
            relatedPaymentAttemptId: null,
            payload: {},
            readAt: null,
            inAppId: null,
            createdAt: new Date().toISOString(),
            channels: [{ channel: "email", status: "sent", failureReason: null }],
          },
        ],
      }),
    );
    render(<NotificationCenter />);

    await screen.findByText(/amendment update/i);
    expect(screen.queryByRole("button", { name: /mark read/i })).not.toBeInTheDocument();
  });
});
