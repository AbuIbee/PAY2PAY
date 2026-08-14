import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAppeals } from "./AdminAppeals";

const APPEAL = {
  id: "appeal-1",
  appealingUserId: "user-1",
  targetResourceType: "admin_restriction",
  targetResourceId: "restriction-1",
  originalDecisionSummary: "Payment activity restricted after chargeback pattern",
  originalDecisionByUserId: "staff-1",
  evidenceDescription: null,
  status: "submitted",
  reviewerUserId: null,
  decision: null,
  rationale: null,
  createdAt: new Date().toISOString(),
};

describe("AdminAppeals", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ appeals: [APPEAL] }), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks assigning the original decision-maker as reviewer", async () => {
    const user = userEvent.setup();
    render(<AdminAppeals />);
    await waitFor(() => expect(screen.getByText(/payment activity restricted/i)).toBeInTheDocument());

    const input = screen.getByLabelText(/assign reviewer/i);
    await user.type(input, "staff-1");

    expect(screen.getByText(/original decision-maker.*pick a different reviewer/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^assign$/i })).toBeDisabled();
  });

  it("allows assigning a different reviewer", async () => {
    const user = userEvent.setup();
    render(<AdminAppeals />);
    await waitFor(() => expect(screen.getByText(/payment activity restricted/i)).toBeInTheDocument());

    const input = screen.getByLabelText(/assign reviewer/i);
    await user.type(input, "staff-2");

    expect(screen.queryByText(/pick a different reviewer/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^assign$/i })).toBeEnabled();
  });
});
