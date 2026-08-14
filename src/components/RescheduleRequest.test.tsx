import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RescheduleRequest } from "./RescheduleRequest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams({ agreementId: "agreement-1" }),
}));

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as Response;
}

const PENDING_REQUEST = {
  id: "req-1",
  installmentScheduleItemId: "inst-1",
  agreementId: "agreement-1",
  currentDueDate: "2026-08-01",
  requestedDueDate: "2026-08-15",
  reason: "Short on funds this month.",
  status: "pending",
  decisionReason: null,
  createdAt: new Date().toISOString(),
};

describe("RescheduleRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists reschedule requests with plain-language status, never a raw enum string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/installments/reschedule/by-agreement")) {
          return jsonResponse({ requests: [PENDING_REQUEST] });
        }
        throw new Error("unexpected fetch");
      }),
    );
    render(<RescheduleRequest />);
    expect(await screen.findByText(/awaiting creditor decision/i)).toBeInTheDocument();
    expect(screen.queryByText("pending")).not.toBeInTheDocument();
  });

  it("approving a request calls decide and refreshes the list", async () => {
    let decided = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/installments/reschedule/decide") && init?.method === "POST") {
          decided = true;
          return jsonResponse({ ...PENDING_REQUEST, status: "approved" });
        }
        if (url.includes("/api/installments/reschedule/by-agreement")) {
          return jsonResponse({ requests: decided ? [{ ...PENDING_REQUEST, status: "approved" }] : [PENDING_REQUEST] });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    render(<RescheduleRequest />);
    const approveButton = await screen.findByRole("button", { name: /approve/i });
    fireEvent.click(approveButton);
    await waitFor(() => expect(screen.getByText(/^approved$/i)).toBeInTheDocument());
  });

  it("shows a safe message (not a raw 403) when a non-creditor tries to decide", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/installments/reschedule/decide") && init?.method === "POST") {
          return jsonResponse({ status: "error", code: "FORBIDDEN", message: "Only the creditor may decide a reschedule request." }, false, 403);
        }
        if (url.includes("/api/installments/reschedule/by-agreement")) {
          return jsonResponse({ requests: [PENDING_REQUEST] });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    render(<RescheduleRequest />);
    const rejectButton = await screen.findByRole("button", { name: /reject/i });
    fireEvent.click(rejectButton);
    expect(await screen.findByText(/only the creditor may approve or reject/i)).toBeInTheDocument();
  });
});
