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

  describe("Production follow-up (Notification cleanup + archive)", () => {
    function notification(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        groupId: "group-1",
        notificationType: "agreement_signed",
        critical: false,
        relatedAgreementId: null,
        relatedPaymentAttemptId: null,
        relatedInvitationId: null,
        payload: {},
        readAt: null,
        inAppId: "notif-in-app-1",
        createdAt: new Date().toISOString(),
        archivedAt: null,
        actionRequired: false,
        channels: [{ channel: "in_app", status: "delivered", failureReason: null }],
        ...overrides,
      };
    }

    it("shows an 'Action required' chip for an action-required notification, and an Archive button in the Current view", async () => {
      vi.stubGlobal("fetch", mockFetchOnce({ notifications: [notification({ notificationType: "amendment", actionRequired: true })] }));
      render(<NotificationCenter />);

      expect(await screen.findByText("Action required")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^archive$/i })).toBeInTheDocument();
    });

    it("switching to the Archived tab requests ?view=archived and renders what it returns", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn().mockImplementation(async (input: string) => {
        if (input === "/api/notifications?view=archived") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ notifications: [notification({ groupId: "archived-1", notificationType: "payment_cleared", archivedAt: new Date().toISOString() })] }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ notifications: [notification()] }) };
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<NotificationCenter />);

      await screen.findByText("Agreement signed"); // Current tab loaded first
      await user.click(screen.getByRole("tab", { name: /archived/i }));

      await screen.findByText("Payment cleared");
      expect(fetchMock.mock.calls.some((call) => call[0] === "/api/notifications?view=archived")).toBe(true);
      // No Archive/Mark read controls in the Archived view.
      expect(screen.queryByRole("button", { name: /^archive$/i })).not.toBeInTheDocument();
    });

    it("archiving a single notification calls the archive endpoint with its groupId and removes it from Current", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn().mockImplementation(async (input: string) => {
        if (input === "/api/notifications/archive") return { ok: true, status: 200, json: async () => ({ archived: true }) };
        return { ok: true, status: 200, json: async () => ({ notifications: [notification()] }) };
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<NotificationCenter />);

      await user.click(await screen.findByRole("button", { name: /^archive$/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/notifications/archive",
          expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "group-1" }) }),
        );
      });
      expect(screen.queryByText(/agreement signed/i)).not.toBeInTheDocument();
    });

    it("'Archive all read/completed' only appears when something is sweepable, calls the bulk endpoint, and reloads Current", async () => {
      const user = userEvent.setup();
      let archiveAllCalled = false;
      const fetchMock = vi.fn().mockImplementation(async (input: string) => {
        if (input === "/api/notifications/archive-all") {
          archiveAllCalled = true;
          return { ok: true, status: 200, json: async () => ({ archived: 1 }) };
        }
        if (input === "/api/notifications") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ notifications: archiveAllCalled ? [] : [notification({ readAt: new Date().toISOString() })] }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ notifications: [] }) };
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<NotificationCenter />);

      const bulkButton = await screen.findByRole("button", { name: /archive all read\/completed/i });
      await user.click(bulkButton);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/notifications/archive-all", expect.objectContaining({ method: "POST" })));
      await waitFor(() => expect(screen.queryByText(/agreement signed/i)).not.toBeInTheDocument());
    });

    it("does not show 'Archive all read/completed' when nothing is sweepable (e.g. only an unread notification exists)", async () => {
      vi.stubGlobal("fetch", mockFetchOnce({ notifications: [notification({ readAt: null })] }));
      render(<NotificationCenter />);

      await screen.findByText(/agreement signed/i);
      expect(screen.queryByRole("button", { name: /archive all read\/completed/i })).not.toBeInTheDocument();
    });
  });

  describe("Agreement page ordering + notification retention (mandatory command): 7-day auto-archive notice", () => {
    function notification(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        groupId: "group-1",
        notificationType: "agreement_signed",
        critical: false,
        relatedAgreementId: null,
        relatedPaymentAttemptId: null,
        relatedInvitationId: null,
        payload: {},
        readAt: null,
        inAppId: "notif-in-app-1",
        createdAt: new Date().toISOString(),
        archivedAt: null,
        actionRequired: false,
        channels: [{ channel: "in_app", status: "delivered", failureReason: null }],
        ...overrides,
      };
    }

    it("shows the 7-day auto-archive notice near the Current/Archived controls, even with no notifications", async () => {
      vi.stubGlobal("fetch", mockFetchOnce({ notifications: [] }));
      render(<NotificationCenter />);

      expect(await screen.findByText(/automatically moved to archived 7 days after being marked as read/i)).toBeInTheDocument();
    });

    it("shows the notice in the Archived view too", async () => {
      const user = userEvent.setup();
      vi.stubGlobal("fetch", mockFetchOnce({ notifications: [] }));
      render(<NotificationCenter />);
      await screen.findByText(/no notifications yet/i);

      await user.click(screen.getByRole("tab", { name: /archived/i }));

      expect(await screen.findByText(/automatically moved to archived 7 days after being marked as read/i)).toBeInTheDocument();
    });

    it("marking read keeps the notification in Current — it does not immediately archive or remove it from view", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn().mockImplementation(async (input: string) => {
        if (input === "/api/notifications/read") return { ok: true, status: 200, json: async () => ({ notification: {} }) };
        return { ok: true, status: 200, json: async () => ({ notifications: [notification({ readAt: null })] }) };
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<NotificationCenter />);

      const markReadButton = await screen.findByRole("button", { name: /mark read/i });
      await user.click(markReadButton);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/notifications/read",
          expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "notif-in-app-1" }) }),
        );
      });
      // Still rendered in the Current view — marking read is not archiving.
      expect(screen.getByText(/agreement signed/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /mark read/i })).not.toBeInTheDocument();
    });
  });
});
