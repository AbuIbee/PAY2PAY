import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepUpChallenge } from "./StepUpChallenge";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

/**
 * Section B (closed-beta remediation, Product Owner review): previously, a not-yet-enrolled user hit
 * a dead end here — the only way forward was a link that navigated the current tab away, losing
 * whatever sensitive action (e.g. signing an agreement) triggered this dialog in the first place.
 * "Set it up in a new tab" + "check again" lets the user return to this exact dialog and resume.
 */
describe("StepUpChallenge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers to check again after enrolling elsewhere, without losing the pending action", async () => {
    let enrolled = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/mfa/status")) return jsonResponse({ enrolled, methods: enrolled ? ["totp"] : [] });
      if (url.includes("/api/auth/mfa/step-up/initiate")) return jsonResponse({ status: "ok" });
      return jsonResponse({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onVerified = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(<StepUpChallenge action="test_action" actionDescription="do the thing" onVerified={onVerified} onCancel={onCancel} />);

    expect(await screen.findByText(/you need to set up two-factor authentication/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /set it up in a new tab/i });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("href", "/account/security");

    enrolled = true;
    await user.click(screen.getByRole("button", { name: /check again/i }));

    expect(await screen.findByLabelText(/code from your authenticator app/i)).toBeInTheDocument();
    // The dialog stayed open and re-checked in place — onCancel (which would abort the pending
    // action) was never called during this flow.
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("still allows cancelling from the not_enrolled state", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ enrolled: false, methods: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(<StepUpChallenge action="test_action" actionDescription="do the thing" onVerified={vi.fn()} onCancel={onCancel} />);

    await screen.findByText(/you need to set up two-factor authentication/i);
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });
});
