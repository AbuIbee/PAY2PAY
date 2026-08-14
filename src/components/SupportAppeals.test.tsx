import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupportAppeals } from "./SupportAppeals";

describe("SupportAppeals", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ appeals: [] }), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not claim there is no live account or agreement functionality", async () => {
    render(<SupportAppeals />);
    await waitFor(() => expect(screen.getByText(/no appeals yet/i)).toBeInTheDocument());
    expect(screen.queryByText(/no live account or agreement functionality/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/support channels are not live yet/i)).not.toBeInTheDocument();
  });

  it("offers a real way to reach support and submit an appeal", async () => {
    render(<SupportAppeals />);
    await waitFor(() => expect(screen.getByText(/no appeals yet/i)).toBeInTheDocument());
    expect(screen.getByText(/support@pay2pay\.com/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit an appeal/i })).toBeInTheDocument();
  });

  it("lists existing appeals with a status chip", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            appeals: [
              {
                id: "a1",
                targetResourceType: "admin_restriction",
                targetResourceId: "r1",
                originalDecisionSummary: "Payment activity restricted",
                evidenceDescription: null,
                status: "under_review",
                decision: null,
                rationale: null,
                decidedAt: null,
                createdAt: new Date().toISOString(),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    render(<SupportAppeals />);
    await waitFor(() => expect(screen.getByText("Payment activity restricted")).toBeInTheDocument());
    expect(screen.getByText("Under review")).toBeInTheDocument();
  });
});
