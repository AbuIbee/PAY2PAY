import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcceptDeclineInvitation } from "./AcceptDeclineInvitation";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams({ invitationId: "inv-1", token: "raw-token" }),
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

function buildFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (url.includes("/api/auth/me")) return jsonResponse({ id: "me", email: "me@example.com" });
    if (url.includes("/api/relationships/invite/resolve")) {
      return jsonResponse({ found: true, invitationId: "inv-1", relationshipId: "rel-1", inviteeEmail: "me@example.com", inviteeRole: "debtor" });
    }
    if (url.includes("/api/profiles")) {
      return jsonResponse({ profiles: [{ kind: "personal", personalProfileId: "profile-1", displayName: "Jane Doe" }] });
    }
    if (url.includes("/api/relationships/accept")) {
      return jsonResponse({ relationship: { id: "rel-1", status: "identities_confirmed" } });
    }
    if (url.includes("/api/relationships/decline")) {
      return jsonResponse({ invitation: { id: "inv-1", status: "declined" } });
    }
    return jsonResponse({}, false);
  });
}

describe("AcceptDeclineInvitation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never auto-accepts — requires an explicit Accept click, and forwards the raw token from the deep link", async () => {
    const user = userEvent.setup();
    const fetchMock = buildFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<AcceptDeclineInvitation />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^accept$/i })).toBeInTheDocument());

    // No accept call has been made yet just from loading the page.
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/relationships/accept"))).toBe(false);

    await user.click(screen.getByRole("button", { name: /^accept$/i }));
    await waitFor(() => expect(screen.getByText(/invitation accepted/i)).toBeInTheDocument());

    const acceptCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/relationships/accept"));
    if (!acceptCall) throw new Error("expected an accept call");
    const [, init] = acceptCall;
    const body = JSON.parse((init as RequestInit).body as string) as { rawToken?: string; invitationId: string };
    expect(body.rawToken).toBe("raw-token");
    expect(body.invitationId).toBe("inv-1");
  });

  it("supports an explicit decline, distinct from accept", async () => {
    const user = userEvent.setup();
    const fetchMock = buildFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<AcceptDeclineInvitation />);
    await waitFor(() => expect(screen.getByRole("button", { name: /decline/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /decline/i }));
    await waitFor(() => expect(screen.getByText(/invitation declined/i)).toBeInTheDocument());
  });
});
