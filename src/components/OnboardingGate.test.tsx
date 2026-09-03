import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingGate } from "./OnboardingGate";

const replace = vi.fn();
let pathname = "/dashboard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname,
}));

function stubCompleteness(body: { ready: boolean; missingFields: string[] }) {
  return vi.fn().mockImplementation(async (input: string) => {
    if (input === "/api/profiles/personal/completeness") {
      return { ok: true, status: 200, json: async () => body };
    }
    throw new Error(`Unhandled fetch: ${input}`);
  });
}

describe("OnboardingGate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    replace.mockClear();
    pathname = "/dashboard";
  });

  it("redirects to Complete Account Setup when required identity fields are missing", async () => {
    vi.stubGlobal("fetch", stubCompleteness({ ready: false, missingFields: ["firstName", "lastName", "line1"] }));
    render(<OnboardingGate />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/account/complete-setup?returnTo=/dashboard");
    });
  });

  it("does not redirect once the account is fully ready", async () => {
    vi.stubGlobal("fetch", stubCompleteness({ ready: true, missingFields: [] }));
    render(<OnboardingGate />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not redirect a brand-new signup whose only gap is a not-yet-verified preferred email", async () => {
    vi.stubGlobal("fetch", stubCompleteness({ ready: false, missingFields: ["preferredEmail"] }));
    render(<OnboardingGate />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replace).not.toHaveBeenCalled();
  });

  it("never redirects away from the Complete Account Setup page itself (no dead loop)", async () => {
    pathname = "/account/complete-setup";
    const fetchMock = stubCompleteness({ ready: false, missingFields: ["firstName"] });
    vi.stubGlobal("fetch", fetchMock);
    render(<OnboardingGate />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("never redirects away from Support (keeps recovery/help reachable)", async () => {
    pathname = "/support";
    const fetchMock = stubCompleteness({ ready: false, missingFields: ["firstName"] });
    vi.stubGlobal("fetch", fetchMock);
    render(<OnboardingGate />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("fails silently (no redirect, no throw) when the completeness check itself errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    expect(() => render(<OnboardingGate />)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replace).not.toHaveBeenCalled();
  });
});
