import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicSupport } from "./PublicSupport";

function mockFetch(loggedIn: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/me")) {
        return new Response(null, { status: loggedIn ? 200 : 401 });
      }
      if (url.includes("/api/appeals")) {
        return new Response(JSON.stringify({ appeals: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
}

describe("PublicSupport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("anonymous visitor", () => {
    beforeEach(() => mockFetch(false));

    it("renders successfully without an authenticated-service failure", async () => {
      render(<PublicSupport />);
      expect(screen.getByText(/account access/i)).toBeInTheDocument();
      expect(screen.getByText(/payment arrangement questions/i)).toBeInTheDocument();
      expect(screen.getByText(/payment or transaction issue/i)).toBeInTheDocument();
      expect(screen.getByText(/identity verification/i)).toBeInTheDocument();
      expect(screen.getByText(/privacy or security concern/i)).toBeInTheDocument();
      expect(screen.getByText(/accessibility assistance/i)).toBeInTheDocument();
      // Never a generic application-failure message.
      expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
    });

    it("never renders the authenticated appeals list/submit widget", async () => {
      render(<PublicSupport />);
      await waitFor(() => expect(screen.getAllByText(/sign in/i).length).toBeGreaterThan(0));
      expect(screen.queryByRole("button", { name: /submit an appeal/i })).not.toBeInTheDocument();
    });

    it("offers an explicit sign-in action instead of executing appeals logic", async () => {
      render(<PublicSupport />);
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: /appealing a decision/i })).toBeInTheDocument(),
      );
      expect(screen.getAllByRole("link", { name: /sign in/i }).length).toBeGreaterThan(0);
    });

    it("does not fabricate a support email, hours, SLA, or live chat", () => {
      render(<PublicSupport />);
      const bodyText = document.body.textContent ?? "";
      expect(bodyText).not.toMatch(/@pay2pay\.com/i);
      expect(bodyText).not.toMatch(/@paid2you\.com/i);
      expect(bodyText.toLowerCase()).not.toContain("24/7");
      expect(bodyText.toLowerCase()).not.toContain("live chat");
      expect(bodyText.toLowerCase()).not.toContain("business hours");
    });
  });

  describe("authenticated visitor", () => {
    beforeEach(() => mockFetch(true));

    it("renders the real appeals functionality once a session is confirmed", async () => {
      render(<PublicSupport />);
      await waitFor(() => expect(screen.getByRole("button", { name: /submit an appeal/i })).toBeInTheDocument());
    });
  });
});
