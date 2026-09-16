import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BankConnectionForm } from "./BankConnectionForm";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

// PAID2YOU — B0-D ADYEN PHASE 2: `@adyen/adyen-web` is a heavy, browser-only SDK — mocked here so
// these tests exercise BankConnectionForm's OWN orchestration logic (details -> session -> mount ->
// poll-for-completion) without needing a real Adyen account or DOM-level Component rendering.
// `capturedConfig` lets a test simulate the shopper completing (or failing) the Component flow by
// invoking the exact callback BankConnectionForm itself passed to AdyenCheckout.
let capturedConfig: { onPaymentCompleted?: () => void; onPaymentFailed?: () => void; onError?: () => void } | null = null;
let mountedOnto: HTMLElement | null = null;
vi.mock("@adyen/adyen-web", () => ({
  AdyenCheckout: vi.fn(async (config: typeof capturedConfig) => {
    capturedConfig = config;
    return {};
  }),
  Ach: class {
    mount(el: HTMLElement) {
      mountedOnto = el;
      return this;
    }
    unmount() {}
  },
}));
vi.mock("@adyen/adyen-web/styles/adyen.css", () => ({}));

const OWNER_PROFILE_ID = "profile-1";

function mockFetchSequence(handlers: Record<string, () => { ok: boolean; status: number; json: () => Promise<unknown> }>) {
  return vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const handler = handlers[key] ?? handlers[input];
    if (!handler) throw new Error(`Unhandled fetch: ${key}`);
    return handler();
  });
}

async function continuePastDetailsStep(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByLabelText(/bank name/i);
  await user.click(screen.getByRole("button", { name: /continue/i }));
}

describe("BankConnectionForm (PAID2YOU — B0-D ADYEN PHASE 2A)", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_ADYEN_CLIENT_KEY = "test_client_key_123";
    capturedConfig = null;
    mountedOnto = null;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_ADYEN_CLIENT_KEY;
    vi.unstubAllGlobals();
    push.mockClear();
    refresh.mockClear();
  });

  it("item 7: fails closed to the unavailable state when NEXT_PUBLIC_ADYEN_CLIENT_KEY is not configured — never starts a session or mounts anything", async () => {
    delete process.env.NEXT_PUBLIC_ADYEN_CLIENT_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<BankConnectionForm />);
    expect(await screen.findByText(/not yet available/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mountedOnto).toBeNull();
  });

  it("collects the bank name BEFORE starting a session, then starts a session, mounts the Ach component, and polls status to completion once the shopper completes the flow — never a raw routing/account number field anywhere", async () => {
    const fetchMock = mockFetchSequence({
      "GET /api/profiles/active": () => ({ ok: true, status: 200, json: async () => ({ kind: "personal", personalProfileId: OWNER_PROFILE_ID }) }),
      "POST /api/relationships/accounts/bank/session": () => ({
        ok: true,
        status: 201,
        json: async () => ({ providerSessionId: "sess_abc", sessionData: "opaque-data" }),
      }),
      "GET /api/relationships/accounts/bank/connect": () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "completed", financialAccountId: "acct-1" }),
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<BankConnectionForm />);

    // Session creation, and any raw bank-detail field, must never appear before the shopper confirms details.
    await screen.findByLabelText(/bank name/i);
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
    expect(screen.queryByLabelText(/routing number/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/account number/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/bank name/i), "Example Bank");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(mountedOnto).not.toBeNull());
    const sessionCall = fetchMock.mock.calls.find((call) => call[0] === "/api/relationships/accounts/bank/session");
    expect(JSON.parse((sessionCall![1] as RequestInit).body as string)).toEqual({
      actingParty: { kind: "personal", id: OWNER_PROFILE_ID },
      institutionDisplayName: "Example Bank",
    });

    // Simulate the shopper completing Adyen's own hosted Component flow.
    capturedConfig?.onPaymentCompleted?.();

    await waitFor(() => {
      const statusCalls = fetchMock.mock.calls.filter((call) => typeof call[0] === "string" && call[0].startsWith("/api/relationships/accounts/bank/connect?"));
      expect(statusCalls.length).toBeGreaterThan(0);
      const url = new URL(statusCalls[0]![0] as string, "http://localhost");
      expect(url.searchParams.get("actingPartyKind")).toBe("personal");
      expect(url.searchParams.get("actingPartyId")).toBe(OWNER_PROFILE_ID);
      expect(url.searchParams.get("providerSessionId")).toBe("sess_abc");
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/payment-methods"));
  });

  it("shows an error and never redirects when the server's webhook-driven status reports failed", async () => {
    const fetchMock = mockFetchSequence({
      "GET /api/profiles/active": () => ({ ok: true, status: 200, json: async () => ({ kind: "personal", personalProfileId: OWNER_PROFILE_ID }) }),
      "POST /api/relationships/accounts/bank/session": () => ({
        ok: true,
        status: 201,
        json: async () => ({ providerSessionId: "sess_abc", sessionData: "opaque-data" }),
      }),
      "GET /api/relationships/accounts/bank/connect": () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "failed", financialAccountId: null }),
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<BankConnectionForm />);
    await continuePastDetailsStep(user);
    await waitFor(() => expect(mountedOnto).not.toBeNull());
    capturedConfig?.onPaymentCompleted?.();

    // Never a manufactured local success, and never redirects — the server's own webhook-confirmed
    // failure is surfaced, not a client-side guess.
    expect(await screen.findByText(/bank couldn't be connected/i)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows a step-up challenge when required (gated behind the details step), and completes session-creation after verification", async () => {
    let stepUpPassed = false;
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "/api/profiles/active") return { ok: true, status: 200, json: async () => ({ kind: "personal", personalProfileId: OWNER_PROFILE_ID }) };
      if (input === "/api/relationships/accounts/bank/session" && init?.method === "POST") {
        if (!stepUpPassed) {
          return {
            ok: false,
            status: 403,
            json: async () => ({ status: "error", code: "STEP_UP_REQUIRED", message: "Step-up verification is required." }),
          };
        }
        return { ok: true, status: 201, json: async () => ({ providerSessionId: "sess_abc", sessionData: "opaque-data" }) };
      }
      if (input === "/api/auth/mfa/status") return { ok: true, status: 200, json: async () => ({ enrolled: true, methods: ["totp"] }) };
      if (input === "/api/auth/mfa/step-up/initiate") return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      if (input === "/api/auth/mfa/step-up/verify") {
        stepUpPassed = true;
        return { ok: true, status: 200, json: async () => ({ passed: true }) };
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<BankConnectionForm />);
    await continuePastDetailsStep(user);

    expect(await screen.findByText(/verify it's you/i)).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/code from your authenticator app/i), "123456");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => expect(mountedOnto).not.toBeNull());
  });
});
