import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InviteConnectionWizard } from "./InviteConnectionWizard";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

describe("InviteConnectionWizard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("walks identity -> invitee -> review -> submit, posting the opposite role for the invitee and showing the waiting state", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/profiles") && !init) {
        return jsonResponse({ profiles: [{ kind: "personal", personalProfileId: "profile-1", displayName: "Jane Doe" }] });
      }
      if (url.includes("/api/profiles")) {
        return jsonResponse({ profiles: [{ kind: "personal", personalProfileId: "profile-1", displayName: "Jane Doe" }] });
      }
      if (url.includes("/api/relationships/invite")) {
        return jsonResponse({ relationship: { id: "rel-1" }, invitation: { id: "inv-1", status: "sent" } }, true);
      }
      return jsonResponse({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<InviteConnectionWizard />);
    await waitFor(() => expect(screen.getByLabelText(/invite as/i)).toBeInTheDocument());

    // Step 1: identity + my role (default creditor)
    await user.click(screen.getByRole("button", { name: /continue/i }));

    // Step 2: invitee email
    await user.type(screen.getByLabelText(/counterparty's email/i), "bilal@example.com");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    // Step 3: review — shows the derived opposite role
    expect(screen.getByText(/bilal@example.com/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /send invitation/i }));

    await waitFor(() => expect(screen.getByText(/waiting for counterparty acceptance/i)).toBeInTheDocument());

    const inviteCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/relationships/invite"));
    const sentBody = JSON.parse((inviteCall?.[1] as RequestInit)?.body as string) as { inviteeRole: string; inviteeEmail: string };
    expect(sentBody.inviteeRole).toBe("debtor"); // opposite of the default "creditor" self-role
    expect(sentBody.inviteeEmail).toBe("bilal@example.com");
  });
});
