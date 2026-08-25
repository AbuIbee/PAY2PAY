import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsList } from "./ConnectionsList";

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  } as Response;
}

describe("ConnectionsList", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/profiles/active")) {
        return jsonResponse({ kind: "personal", personalProfileId: "profile-1", displayName: "Jane Doe" });
      }
      if (url.includes("/api/relationships?")) {
        return jsonResponse({
          relationships: [
            { id: "rel-1", status: "active", currentAgreementId: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
          ],
        });
      }
      return jsonResponse({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("scopes the relationship list request to the active party's kind and id — never a hardcoded or missing party", async () => {
    render(<ConnectionsList />);
    await waitFor(() => expect(screen.getByText(/active/i)).toBeInTheDocument());
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls.some((url) => url.includes("partyKind=personal") && url.includes("partyId=profile-1"))).toBe(true);
  });

  it("renders a status chip with plain-language text, never the raw enum string alone", async () => {
    render(<ConnectionsList />);
    await waitFor(() => expect(screen.getByText("Active")).toBeInTheDocument());
  });

  it("Agreement Lifecycle V2 UAT (Defect 4): shows an empty state pointing to the Agreement workflow (not /connections/invite) when there are no connections", async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/profiles/active")) {
        return jsonResponse({ kind: "personal", personalProfileId: "profile-1", displayName: "Jane Doe" });
      }
      if (url.includes("/api/relationships?")) {
        return jsonResponse({ relationships: [] });
      }
      return jsonResponse({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectionsList />);
    await waitFor(() => expect(screen.getByText(/no connections yet/i)).toBeInTheDocument());
    const cta = screen.getByRole("link", { name: /propose a payment plan/i });
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveAttribute("href", "/agreements/invite");
  });
});
